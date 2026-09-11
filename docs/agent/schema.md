# Agent 表结构设计

依据 GLM Managed Agents 的 Agent 资源模型（见 `references/agent-setup.md` 与 `references/api/*-agent*.md`）设计，
落库于 D1（SQLite），通过 Drizzle 定义在 `packages/db/src/schema.ts`。

## 设计原则

1. **与 API wire-format 一一对应**：GLM 的 Agent 响应字段（`id` / `type` / `name` / `model` / `system` / `description` / `tools` / `skills` / `mcp_servers` / `metadata` / `version` / `created_at` / `updated_at` / `archived_at`）都能直接从表中读出，序列化时无需拼装。
2. **版本不可变**：每次配置变化生成一个新的不可变快照版本；「当前版本」只是 Agent 级的一个指针。历史版本永远可完整还原（对应 `GET /v1/agents/{agentId}/versions` 返回完整配置快照）。
3. **落库即归一化**：服务层在写入前补全所有默认值（model 的 effort/speed、工具集的 default_config、configs 的继承解析），使版本快照与响应回显完全一致，读取时零加工。
4. **Agent 级与版本级分离**：`archived_at` 是 Agent 级字段，各版本自带版本级 `created_at` / `updated_at` —— 与 GLM「列出版本」页的语义一致。

## 表结构

### `agents` — Agent 级状态

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | Agent ID，`agent_` + 小写 UUIDv7（与 GLM 的 `agent_0191xxxx-…` 形态一致） |
| `current_version` | INTEGER | NOT NULL | 当前版本号，指向 `agent_versions(agent_id, version)`；创建时为 1 |
| `archived_at` | INTEGER (ts_ms) | NULL | 归档时间；Agent 级字段，所有版本共享。NULL 表示未归档 |
| `created_at` | INTEGER (ts_ms) | NOT NULL | Agent 创建时间（= 版本 1 的 `created_at`），列表排序键 |
| `updated_at` | INTEGER (ts_ms) | NOT NULL | 冗余当前版本的 `updated_at`，避免列表 JOIN |

索引：

- `idx_agents_created_at_id (created_at, id)` — 列表接口 `GET /v1/agents` 默认按创建时间倒序，配合 keyset 游标分页。

### `agent_versions` — 不可变配置快照

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `agent_id` | TEXT | NOT NULL, FK → `agents.id` | 所属 Agent |
| `version` | INTEGER | NOT NULL, ≥ 1 | 版本号，从 1 递增 |
| `name` | TEXT | NOT NULL, 1–256 | Agent 名称（版本级快照的一部分） |
| `description` | TEXT | NULL, ≤ 2048 | 用途说明 |
| `system` | TEXT | NULL, ≤ 100000 | 系统提示词 |
| `model_id` | TEXT | NOT NULL | `glm-5.3` 或 `glm-5.3-flash` |
| `model_effort` | TEXT | NOT NULL | `low` / `high` / `max`；**写入时已按模型补全默认档位**（glm-5.3→max，glm-5.3-flash→high） |
| `model_speed` | TEXT | NOT NULL | 当前仅 `standard`；写入时补全 |
| `tools` | TEXT (JSON) | NOT NULL, default `'[]'` | 归一化后的工具集数组（见下） |
| `skills` | TEXT (JSON) | NOT NULL, default `'[]'` | Skill 引用数组（`{type, skill_id, version}`） |
| `mcp_servers` | TEXT (JSON) | NOT NULL, default `'[]'` | MCP Server 数组（`{type: "url", name, url}`） |
| `metadata` | TEXT (JSON) | NOT NULL, default `'{}'` | 键值对，≤ 16 键、键 ≤ 64、值 ≤ 512 字符 |
| `created_at` | INTEGER (ts_ms) | NOT NULL | 版本生成时间 |
| `updated_at` | INTEGER (ts_ms) | NOT NULL | 不可变快照，恒等于本行 `created_at` |

主键：`(agent_id, version)`。同时天然覆盖「取当前版本」（`agent_id + version` 点查）与「列出版本」（`agent_id` 范围扫描，按 `version` 排序）两类查询，无需额外索引。

### 为什么是两张表而不是一张

单表方案（一行 = 一个版本 + `is_current` 标记）也能实现版本历史，但：

- 更新时要同时改旧行标记、写新行，不可变快照与可变状态混在一行；
- 「取当前 Agent」需要 `is_current` 过滤或冗余列，且并发更新窗口更大；
- 归档时间戳会被迫复制到每个版本行（GLM 语义中它是 Agent 级的）。

两张表后，更新 = **插入一条版本行 + 更新 agents 指针**，在一个 D1 batch（隐式事务）内完成。

## JSON 列的归一化形态

`tools` / `skills` / `mcp_servers` / `metadata` 以归一化（补全默认值后的）形态存储，与 API 响应结构逐字段一致：

```jsonc
// tools: 数组元素三选一（oneOf），default_config 与 configs 均为具体值（无 null 继承）
[
  {
    "type": "agent_toolset_20260601",
    "default_config": { "enabled": true, "permission_policy": { "type": "always_allow" } },
    "configs": [
      { "name": "bash", "enabled": false, "permission_policy": { "type": "always_ask" } }
    ]
  },
  {
    "type": "mcp_toolset",
    "mcp_server_name": "knowledge-base",
    "default_config": { "enabled": true, "permission_policy": { "type": "always_allow" } },
    "configs": []
  },
  {
    "type": "custom",
    "name": "lookup_order",
    "description": "查询订单状态",
    "input_schema": { "type": "object", "properties": {}, "required": [] }
  }
]
```

- 请求中允许的「省略 / null = 继承默认」只存在于写入路径；落库前由服务层（zod 校验 + 归一化）解析为具体值。
- 数组字段整体替换（不 diff、不追加），与 GLM 更新语义一致，天然适合快照存储。

## 关键读写流程

### 创建

```
batch:
  1. INSERT INTO agents (id, current_version=1, created_at, updated_at)
  2. INSERT INTO agent_versions (agent_id, version=1, …归一化配置)
```

### 更新（乐观并发）

1. 读当前版本快照，按 GLM 语义合并请求（标量整体替换、数组整体替换、metadata 按键合并）。
2. 与当前快照做无变化检测：完全一致则直接返回现有版本，不写库。
3. 事务内写入新版本：

```sql
-- version 匹配则指针前移；不匹配说明期间有人改过 → 0 行受影响 → 返回 409
UPDATE agents
   SET current_version = current_version + 1,
       updated_at      = :now
 WHERE id = :agentId
   AND current_version = :expectedVersion
   AND archived_at IS NULL;
-- 同一 D1 batch 中先 INSERT 新的 agent_versions 行（version = expected + 1）
```

- 请求携带 `version`：以 `:expectedVersion` 做 CAS，失败返回 409（`invalid_request_error`，与 GLM 的冲突语义一致）。
- 请求省略 `version`：先读 `current_version` 再走同一 CAS（覆盖式同步）。
- `archived_at IS NULL` 兜底已归档 Agent 拒绝更新（400）。

### 归档（幂等）

```sql
UPDATE agents SET archived_at = :now
 WHERE id = :agentId AND archived_at IS NULL;
```

重复归档不改动、返回当前 Agent。归档后版本历史仍可读，新会话不可再引用。GLM 中归档会级联归档运行中的 Deployment；nano 一期没有 Deployment 资源，此联动留待引入 Deployment 表时补充。

## 校验规则（服务层，zod；DB 只保留基本约束）

| 规则 | 来源 |
| --- | --- |
| `name` 1–256 字符； | 创建必填 |
| `system` ≤ 100000；`description` ≤ 2048，均可为 null | — |
| `tools` ≤ 128 项；`skills` ≤ 20 项且 `(skill_id, version)` 不重复；`mcp_servers` ≤ 20 项 | — |
| `skills[]` 引用的 `(skill_id, version)` 必须存在于 `skill_versions`（见 [Skill schema](../skills/schema.md)）；`type` 仅 `custom`，nano 无平台内置（`zai`）Skill | 引用一致性 |
| `metadata` ≤ 16 键，键 ≤ 64 字符，值 ≤ 512 字符 | — |
| `mcp_servers[].name` 数组内唯一，且每个必须与**恰好一个** `mcp_toolset.mcp_server_name` 同名对应；提交 `mcp_toolset` 时必须同请求提交 `mcp_servers` | 引用一致性 |
| 配置 `skills` 非空时，`tools` 必须包含 `agent_toolset_20260601` | Skill 依赖内置工具集 |
| 自定义工具 `name` 匹配 `^[A-Za-z0-9_-]+$`、不以 `mcp__` 开头、配置内唯一；`description` 1–4096 | — |
| 内置工具名枚举：`read` / `write` / `edit` / `bash` / `grep` / `find` / `ls`；`configs[].name` 不重复 | — |
| MCP URL：`https://` 开头、≤ 2048、无凭据 / fragment / 空 query / 旧式 SSE 路径 | — |

## Drizzle 定义（落地到 `packages/db/src/schema.ts`）

```ts
import { index, integer, primaryKey, sql, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Agent 级状态：身份、当前版本指针、归档时间 */
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(), // agent_ + UUIDv7
    currentVersion: integer("current_version").notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_agents_created_at_id").on(t.createdAt, t.id)],
);

/** 版本级配置快照：写入后不可变；JSON 列存归一化形态 */
export const agentVersions = sqliteTable(
  "agent_versions",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    system: text("system"),
    modelId: text("model_id").notNull(),
    modelEffort: text("model_effort").notNull(),
    modelSpeed: text("model_speed").notNull(),
    tools: text("tools", { mode: "json" })
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'`),
    skills: text("skills", { mode: "json" })
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'`),
    mcpServers: text("mcp_servers", { mode: "json" })
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'`),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.version] })],
);
```

`$type<…>` 的具体类型（`AgentToolset[]` 等）由 `@nano/shared` 的 zod schema 推导后回填，保证 DB 与 API 类型同源。

## 约定

- **时间戳**：DB 存 `timestamp_ms` 整数；API 输出 ISO 8601 UTC（`2026-08-20T08:24:10.412Z`）。
- **`type: "agent"` 与 `multiagent: null`**：响应固定字段，不落库，序列化时注入（`multiagent` 当前未支持，恒为 null）。
- **无删除**：与 GLM 一致，Agent 没有 delete 端点，归档即终止操作。
- **分页游标**：列表按 `(created_at, id)` keyset、列出版本按 `version` keyset，游标 base64 编码后经 `next_page` 返回，对客户端 opaque。
