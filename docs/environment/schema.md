# Environment 表结构设计

依据 GLM Managed Agents 的 Environment 资源模型（见 `references/cloud-environment.md` 与 `references/api/*-environment*.md`）设计，
落库于 D1（SQLite），通过 Drizzle 定义在 `packages/db/src/schema.ts`。

## 设计原则

1. **与 API wire-format 一一对应**：GLM 的 Environment 响应字段（`id` / `type` / `name` / `description` / `metadata` / `config` / `scope` / `state` / `archived_at` / `created_at` / `updated_at`）中，除两个固定回显字段外都能直接从表中读出，序列化时无需拼装。
2. **落库即归一化**：服务层在写入前补全所有默认值（`config` 省略时展开为 cloud + 空 packages + unrestricted、六类包管理器键全部出现、`allowed_hosts` 小写化并排序去重），使落库形态与响应回显完全一致，读取时零加工。
3. **单表无版本**：与 Agent 的「两张表 + 不可变版本快照」不同，Environment 是单张可变行——GLM 的 Environment 没有 `version` 字段，也没有列出版本的端点；「配置被会话固化」的快照语义发生在 Session 侧，环境本身只需要保存当前态。
4. **`state` 与 `archived_at` 双字段**：GLM 的 wire format 同时携带枚举 `state`（`active` / `archived`）与可空时间戳 `archived_at`，两者都落库并维持不变式 `archived_at IS NULL ⟺ state = 'active'`。

## 表结构

### `environments` — 单表当前态

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | Environment ID，`env_` + 小写 UUIDv7（与 GLM 的 `env_019e…` 形态一致） |
| `name` | TEXT | NOT NULL, 1–256 | Environment 名称 |
| `description` | TEXT | NULL, ≤ 1024 | 用途说明 |
| `config` | TEXT (JSON) | NOT NULL | 归一化后的完整运行环境配置（见下） |
| `metadata` | TEXT (JSON) | NOT NULL, default `'{}'` | 键值对，≤ 16 键、键 ≤ 64、值 ≤ 512 字符 |
| `state` | TEXT | NOT NULL, `active` / `archived` | 生命周期状态；创建时为 `active`，归档后不可逆 |
| `archived_at` | INTEGER (ts_ms) | NULL | 归档时间；与 `state` 维持不变式 `archived_at IS NULL ⟺ state = 'active'` |
| `created_at` | INTEGER (ts_ms) | NOT NULL | 创建时间，列表排序键 |
| `updated_at` | INTEGER (ts_ms) | NOT NULL | 最近一次实际写库的时间；无变化更新不刷新 |

索引：

- `idx_environments_created_at_id (created_at, id)` — 列表接口 `GET /v1/environments` 默认按创建时间倒序，配合 keyset 游标分页。

### 为什么是一张表而不是两张

Agent 采用 `agents` + `agent_versions` 两张表，根因是 GLM 的 Agent 有**不可变版本**：配置每次变化生成新快照，wire format 携带 `version` 字段，还有一个「列出版本」端点。Environment 没有这些：

- wire format 无 `version` 字段，客户端没有可引用、可携带的版本号；
- 没有「列出配置历史」的端点，历史配置在 GLM 侧也不可查询；
- 「改了环境只影响新会话」的快照语义，固化动作发生在**创建会话时**、存储位置在 Session 侧（会话持有自己的环境快照），环境表没有为会话保留历史配置的义务。

因此版本表在这里没有对应物：更新就是就地覆盖单行。代价是放弃了乐观并发（见下文「更新」），换来的是单表单行的最简读写路径。

## JSON 列的归一化形态

`config` / `metadata` 以归一化（补全默认值后的）形态存储，与 API 响应结构逐字段一致：

```jsonc
// config: 归一化后的完整形态——六类包管理器键全部出现（未声明为空数组），
// networking 为具体生效的策略（无 null / 省略形态）
{
  "type": "cloud",
  "packages": {
    "type": "packages",
    "apt": ["poppler-utils"],
    "cargo": [],
    "gem": [],
    "go": [],
    "npm": ["typescript"],
    "pip": ["pandas", "matplotlib", "openpyxl"]
  },
  "networking": { "type": "unrestricted" }
}

// networking 为 limited 时：allowed_hosts 已小写化、排序、去重，两个开关为具体布尔值
{
  "type": "limited",
  "allowed_hosts": ["api.example.com", "*.internal.example.com"],
  "allow_package_managers": true,
  "allow_mcp_servers": false
}
```

- 请求中允许的「省略 / null = 取默认」只存在于写入路径；落库前由服务层（zod 校验 + 归一化）解析为具体值。
- `config` 的更新语义是**整体替换（非深合并）**：提交的 config 完全取代现有值，落库形态不涉及增量合并的中间态。
- 包名列表去重后**保留首次出现顺序**（GLM 仅声明去重，未声明排序）；`allowed_hosts` 则**小写化、排序、去重**，保证同一输入的回显确定。
- `metadata` 键级合并发生在写入路径，落库的永远是合并后的完整对象。

## 关键读写流程

### 创建

```
INSERT INTO environments (id, name, description, config, metadata, state='active', created_at, updated_at)
```

归一化在写入前完成：`config` 省略或为 null 时展开为 `{type: "cloud", 空 packages, unrestricted}`。单条插入即完整业务动作，没有跨表一致性要求（对照 Agent 创建的两表 batch）。

### 更新（就地覆盖，最后写入获胜）

1. 读当前行，不存在返回 404。
2. 检查 `state`，已归档返回 400（GLM：归档后的 Environment 不能更新）。
3. 按 GLM 语义合并请求：`name` / `description` 标量整体替换（description 可传 null 清空）；**`config` 整体替换**，传 null 恢复默认 cloud 配置；`metadata` 按键级合并（提交键覆盖、null 删键、未提及保留）；`scope` null / 省略不变。
4. 无变化检测：合并结果与当前行完全一致时不写库、`updated_at` 不变，直接返回现状。
5. 写入：

```sql
UPDATE environments
   SET name        = :name,
       description = :description,
       config      = :config,
       metadata    = :metadata,
       updated_at  = :now
 WHERE id = :environmentId
   AND state = 'active';
```

受影响行数为 0 说明读取之后行被删除或被归档：重读一次区分 404 与 400，不能笼统处理。

**为什么没有乐观并发**：Agent 的 409 语义来自请求可携带 `version` 做 CAS；Environment 的 wire format 没有 version 字段，客户端没有期望值可提交，GLM 的行为就是最后写入获胜。快照语义也收敛了并发更新的影响面——中途被改只影响之后创建的会话，正在运行的会话持有自己的固化快照，不受波及。

### 归档（幂等，不可逆）

```sql
UPDATE environments
   SET state       = 'archived',
       archived_at = :now
 WHERE id = :environmentId
   AND state = 'active';
```

重复归档不改动任何数据，返回当前行。归档后：更新返回 400；资源仍可读取、仍出现在列表中；GLM 中还会阻止新会话 / 部署绑定并在下一次消费环境的交互时终止仍引用它的会话——nano 一期没有 Session / Deployment 资源，此联动留待引入时补充。没有恢复（unarchive）端点。

### 删除（硬删除，无引用计数）

```sql
DELETE FROM environments WHERE id = :environmentId;
```

受影响行数为 0 返回 404。与 GLM 一致，删除**不做引用计数**：引用方在下一次使用该环境时得到 not found。归档与未归档的环境均可删除——归档是「阻止新绑定」的软终止，删除是移除资源记录的硬终止。一期没有 Session 表，也就没有引用可查；将来 Session 引入后维持同样的无引用计数语义（会话持有自己的环境快照，删除不影响已固化的会话，只影响新会话的创建）。

## 校验规则（服务层，zod；DB 只保留基本约束）

| 规则 | 来源 |
| --- | --- |
| `name` 1–256 字符；创建必填，更新省略不变 | — |
| `description` ≤ 1024，可为 null；更新传 null 清空 | — |
| `metadata` ≤ 16 键，键 ≤ 64 字符，值 ≤ 512 字符 | — |
| `scope` 仅 `organization`；创建省略取默认，更新 null / 省略不变 | 单租户裁剪（见 [api/README.md](api/README.md#与-glm-managed-agents-的差异)） |
| `config.type` 仅 `cloud`；`self_hosted` 被拒绝 | GLM 一期范围 |
| `config` 及其嵌套对象（packages / networking）出现未知字段一律 400（zod `.strict()`） | `additionalProperties: false` |
| `packages` 六类管理器每类 ≤ 200 项（去重后）；每项 trim 后非空、≤ 256 字符、不含空白或控制字符、不以 `-` 开头；重复项去重 | — |
| `networking` 是二选一 tagged union：`unrestricted` 不得携带任何其他字段；`limited` 的 `allowed_hosts` ≤ 256 项、每项 ≤ 255 字符、仅 hostname 或 `*.example.com` 通配（不得含协议、端口、路径），服务端小写化、排序、去重 | — |
| `allow_package_managers` / `allow_mcp_servers` 省略或 null 时为 false | — |
| **limited 且六类 packages 任一非空时，`allow_package_managers` 必须显式 `true`，否则 400** | 包管理器联网联动 |
| 上一条联动校验作用于**合并后的完整配置**而非请求补丁——config 整体替换语义下两者等价，收口在合并结果是防御性选择：将来若引入部分更新语义，校验位置无需变动 | 更新语义 |

## Drizzle 定义（落地到 `packages/db/src/schema.ts`）

```ts
import { index, integer, sql, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Environment 当前态：单表无版本，config 以归一化形态存储 */
export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(), // env_ + UUIDv7
    name: text("name").notNull(),
    description: text("description"),
    config: text("config", { mode: "json" })
      .$type<unknown>()
      .notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    state: text("state")
      .$type<"active" | "archived">()
      .notNull()
      .default("active"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_environments_created_at_id").on(t.createdAt, t.id)],
);
```

`$type<…>` 的具体类型（`EnvironmentConfig` 等）由 `@nano/shared` 的 zod schema 推导后回填，保证 DB 与 API 类型同源。

## 约定

- **时间戳**：DB 存 `timestamp_ms` 整数；API 输出 ISO 8601 UTC（`2026-09-11T08:00:00.000Z`）。
- **`type: "environment"` 与 `scope: "organization"`**：响应固定字段，不落库，序列化时注入（nano 单租户，scope 仅为 wire 兼容保留）。
- **归档与删除**：归档幂等且不可逆（无恢复端点）；删除是硬终止且无引用计数。两者都作用于任何 `state` 的行（更新只作用于 `active`）。
- **分页游标**：列表按 `(created_at, id)` keyset，游标 base64url 编码后经 `next_page` 返回，对客户端 opaque。
- **快照语义**：环境配置在创建会话时被固化为该会话的环境快照，环境表只保存当前态；该语义在 nano 侧待 Session 模块引入时落地（见 [api/README.md](api/README.md#快照语义预留)）。
