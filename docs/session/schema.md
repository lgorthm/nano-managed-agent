# Session 表结构设计

依据 GLM Managed Agents 的 Session 资源模型（见 `references/create-session.md`、`references/session-operations.md` 与 `references/api/*session*.md`）设计，
落库于 D1（SQLite），通过 Drizzle 定义在 `packages/db/src/schema.ts`。

## 一期范围与裁剪

GLM 的 Session 是「一次实际运行的载体」：事件收发、SSE 推流、沙箱供给、Agent 循环都挂在它身上。nano 一期只落地 **元数据控制面**——会话的创建、检索、更新、归档、删除与 File 资源挂载；事件与运行时（`SESSION_DO` Durable Object 内自管执行，定稿设计见 [runtime.md](runtime.md)）属二期。由此产生四条一期裁剪，全文一致遵守：

1. **`status` 一期恒为 `idle`**。wire 上保留 GLM 全部四个枚举值（`idle` / `running` / `rescheduling` / `terminated`），但一期没有任何组件会驱动状态迁移；`running` 门禁（更新 tools 409、归档 409、删除 409）照常实现，为二期运行时就位后直接生效。
2. **事件不落库**。`initial_events` 字段在 wire 上保留（≤ 50 条），非空数组一期返回 400——事件历史的存储位置在二期的 `SESSION_DO`，先在 D1 里开一个事件存放点、二期再迁移，不如一开始就拒绝。`x-events-encrypted` / `x-checkpoint` 协议头一期忽略。
3. **`vault_ids` 一期恒为 `[]`**。nano 没有 Vault 资源（控制台的 memory / vault 管理直连 GLM），字段保留、非空返回 400；不落库，序列化时注入。
4. **`resources` 一期仅支持 `file` 类型**。nano 没有 Memory Store 资源，`type: "memory_store"` 返回 400（列上保留 `type` 值为它预留）。

## 设计原则

1. **与 API wire-format 一一对应**：GLM 的 Session 响应字段中，凡一期有真实状态的（`id` / `agent` / `environment_id` / `status` / `title` / `metadata` / `resources` / `usage` / `created_at` / `updated_at` / `archived_at`）都能直接从表中读出；四个一期无状态的字段（`type` / `vault_ids` / `outcome_evaluations` / `stats` / `budget`）不落库，序列化时注入固定值。
2. **快照固化，创建即冻结**：`agent` 与 `environment` 都以「创建时点的解析结果」落库。会话持有自己的环境快照（[Environment schema](../environment/schema.md) 中「快照固化发生在 Session 侧」语义的落点），Agent 侧持有「钉住版本 ⊕ 会话级覆盖」的完整解析快照。此后对 Agent / Environment 的任何变更都不影响既有会话。
3. **单表无版本**：Session 没有 `version` 字段、没有版本端点，更新是就地覆盖单行（同 Environment 先例）；wire 上没有可提交的期望值，并发语义为最后写入获胜。
4. **挂载关系独立成表**：`session_resources` 归 session 模块（挂载端点在 `/v1/sessions/*` 下，对齐 GLM 归属，见 [File schema](../files/schema.md) 的预留条款）；File 本体是独立资源，不随会话删除，删除的只是挂载记录。产出编目同样独立成表（`session_outputs`，见下）：语义与挂载相反——产出 File 随会话删除级联清理。

## 表结构

### `sessions` — 会话当前态

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | Session ID，`sess_` + 小写 UUIDv7（与 GLM 的 `sess_01J…` 形态对应） |
| `agent_id` | TEXT | NOT NULL | 钉住的 Agent ID；列表 `agent_id` 过滤键 |
| `agent_version` | INTEGER | NOT NULL, ≥ 1 | 钉住的 Agent 版本号；列表 `agent_version` 过滤键 |
| `agent_config` | TEXT (JSON) | NOT NULL | 解析后的完整 Agent 配置快照（见下），与 wire 的 `session.agent` 逐字段同构 |
| `environment_id` | TEXT | NOT NULL | 引用的 Environment ID；仅回显，配置以快照为准 |
| `environment_snapshot` | TEXT (JSON) | NOT NULL | 固化的环境配置快照（归一化后的 `EnvironmentConfig`）；一期不回显，供二期运行时供给沙箱 |
| `status` | TEXT | NOT NULL, default `'idle'` | `idle` / `running` / `rescheduling` / `terminated`；一期恒 `idle` |
| `title` | TEXT | NULL, ≤ 256 | 会话标题 |
| `metadata` | TEXT (JSON) | NOT NULL, default `'{}'` | 键值对，≤ 16 键、键 ≤ 64、值 ≤ 512 字符 |
| `input_tokens` | INTEGER | NOT NULL, default 0 | 累计输入 token；一期恒 0，二期由运行时累计 |
| `output_tokens` | INTEGER | NOT NULL, default 0 | 累计输出 token |
| `cache_read_input_tokens` | INTEGER | NOT NULL, default 0 | 累计缓存命中输入 token |
| `archived_at` | INTEGER (ts_ms) | NULL | 归档时间；NULL 表示未归档 |
| `created_at` | INTEGER (ts_ms) | NOT NULL | 创建时间，列表排序键 |
| `updated_at` | INTEGER (ts_ms) | NOT NULL | 最近一次实际写库的时间；无变化更新不刷新 |

索引：

- `idx_sessions_created_at_id (created_at, id)` — 列表默认按创建时间倒序，配合 keyset 游标分页。
- `idx_sessions_agent_version (agent_id, agent_version, created_at, id)` — `agent_id` 过滤命中前缀；`agent_id` + `agent_version` 过滤完整命中，两者都能继续按 `(created_at, id)` 走 keyset。

### `session_resources` — 会话挂载的 File 资源

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | Resource ID，`sres_` + 小写 UUIDv7 |
| `session_id` | TEXT | NOT NULL, FK → `sessions.id` | 所属会话；随会话删除级联清理 |
| `type` | TEXT | NOT NULL, default `'file'` | 一期恒 `file`；为二期的 `memory_store` 预留 |
| `file_id` | TEXT | NOT NULL | 软引用 `files.id`，写入时校验存在（与 `agent_versions.skills` 同款软引用策略） |
| `mount_path` | TEXT | NOT NULL | 归一化后的沙箱内绝对路径（见下），`/mnt/session/uploads` 之下 |
| `created_at` | INTEGER (ts_ms) | NOT NULL | 挂载时间，列表排序键 |
| `updated_at` | INTEGER (ts_ms) | NOT NULL | 不可变行，恒等于本行 `created_at` |

索引与约束：

- `idx_session_resources_session (session_id, created_at, id)` — 会话的资源列表分页。
- `idx_session_resources_file_id (file_id)` — File 删除时的引用检查（被未归档会话挂载即拒绝）。
- `UNIQUE (session_id, mount_path)` — 完全相同路径的兜底约束；「前缀包含」类重叠仍由服务层检查（见下）。

### `session_outputs` — 会话产出文件的编目映射

沙箱产出文件（`/mnt/session/outputs`）在每个 turn 收尾收割编目为 File 资源的映射表，设计细节与收割协议见 [../files/schema.md](../files/schema.md)「会话产出文件」。与 `session_resources` 的挂载语义相对：挂载是**输入**（File 本体独立、不随会话删），产出是**输出**（File 生命周期从属于会话，随会话删除级联清理）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `file_id` | TEXT | PK, FK → `files.id` | 当前代表的 File 行；换代时就地改指新行 |
| `session_id` | TEXT | NOT NULL, FK → `sessions.id` | 产出会话；随会话删除级联清理（并连带删 File 行） |
| `path` | TEXT | NOT NULL | outputs 目录下的相对路径 |
| `content_sha256` | TEXT | NOT NULL | 内容指纹；收割幂等的判断依据（未变即跳过） |
| `created_at` | INTEGER (ts_ms) | NOT NULL | 首编目时间 |
| `updated_at` | INTEGER (ts_ms) | NOT NULL | 最近一次换代时间 |

索引与约束：

- `UNIQUE (session_id, path)` — 一个产出路径只指向一个当前 File。
- `idx_session_outputs_session (session_id, updated_at, file_id)` — 收割对比、冷启物化回填与删除前取 fileIds 都按会话查询。

## JSON 列的归一化形态

### `agent_config` — 解析后的 Agent 配置快照

创建时由 `resolveSessionAgent`（shared 纯函数）产出：**钉住的 `agent_versions` 行 ⊕ 会话级覆盖**，覆盖按字段整体替换（非深合并）。落库后即为会话的全部 Agent 事实，后续仅 `tools` / `mcp_servers` 可经更新端点整体替换，其余字段冻结：

```jsonc
// 与 wire 的 session.agent 逐字段一致（multiagent 由序列化注入）
{
  "name": "Coding Assistant",
  "model": { "id": "glm-5.3", "effort": "max", "speed": "standard" },
  "system": "You are a helpful coding agent.",
  "description": null,
  "tools": [ /* 归一化后的工具集数组，形态同 agent_versions.tools */ ],
  "skills": [ /* SkillReference[] */ ],
  "mcp_servers": [ /* McpServer[] */ ]
}
```

- `agent_id` / `agent_version` / `type: "agent"` / `multiagent: null` 不进 JSON 列：前三者是独立列，`multiagent` 是序列化注入的固定字段。
- 覆盖里的「省略 = 继承版本、null = 清空、空数组 = 清空」只存在于解析路径；`resolveSessionAgent` 的输出全是具体值，与 Agent 模块「落库即归一化」原则一致。
- 跨字段校验（`mcp_toolset` ↔ `mcp_servers` 一一对应、`skills` 非空须含 `agent_toolset_20260601`、skills 引用存在性）作用于**解析后的最终配置**，与 GLM「MCP 映射约束在合并后的最终配置上校验」语义一致。

### `environment_snapshot` — 固化的环境配置

创建时从 `environments` 行拷贝归一化后的 `EnvironmentConfig`（整体 JSON 复制，无二次加工）。Environment 后续的更新、归档、删除都不触碰这份快照；二期运行时供给沙箱只读它，不回读 `environments` 表。wire 一期只回显 `environment_id`，快照不出现在响应里。

## 关键读写流程

### 创建（引用解析 → 校验 → 单 batch 写入）

```
1. 解析 agent 引用：
   - 字符串 / {type:"agent"} 省略 version → 钉当前版本
   - 指定 version → 读 agent_versions(agent_id, version)，不存在 → 400，message 提示当前最新版本
   - agent 本身不存在 → 404
2. resolveSessionAgent(版本配置, 覆盖) → 最终配置；在最终配置上校验 mcp 映射 / skills 联动
3. 校验 skills 引用存在性（复用 findMissingSkillVersionPairs）→ 缺失 400
4. 读 environments：不存在 → 404；已归档 → 400；存在则固化 environment_snapshot
5. 校验 resources[]：file_id 存在（缺失 400）、mount_path 归一化 + 重叠检查
6. batch:
     INSERT INTO sessions (…, status='idle', usage 三列 = 0)
     INSERT INTO session_resources × N
```

引用不存在的错误码约定（与 Agent 模块的先例一致）：**顶层资源引用不存在 → 404**（`agent` / `environment_id`）；**配置内引用不存在或引用状态不可用 → 400**（`version`、`resources[].file_id`、已归档的 `environment_id`）。

### 更新（就地覆盖，最后写入获胜）

1. 读当前行，不存在返回 404。
2. 已归档返回 409（`session_archived` 语义）。
3. 按字段分派：`title` / `metadata` 任意状态可改（title 传 null 清空；metadata 按键级合并）；`agent.tools` / `agent.mcp_servers` 仅 `idle` 可改（否则 409 `session_not_idle`），整体替换写进 `agent_config`，替换后在最终配置上重验 mcp 映射。
4. `model` / `system` / `skills` / `vault_ids` / `environment_id` / `resources` 创建即冻结，出现在请求里即 400（schema `.strict()`）。
5. 无变化检测：合并结果与当前行完全一致时不写库、`updated_at` 不变，直接返回现状（同 Environment 先例）。
6. 写入单条 `UPDATE … WHERE id = ? AND archived_at IS NULL`；受影响 0 行说明期间被归档，重读区分 404 / 409。

没有乐观并发：Session 的 wire format 没有 `version` 字段可提交（对照 Agent 的 409 语义来源），GLM 的行为就是最后写入获胜。`agent_config` 的读-改-写（tools 整体替换）在最坏情况下丢失一次并发更新，一期单租户 + 一期恒 idle 的负载下可接受。

### 归档（**非幂等**，注意与 Agent / Environment 不同）

```sql
UPDATE sessions SET archived_at = :now, updated_at = :now
 WHERE id = :sessionId AND archived_at IS NULL AND status != 'running';
```

GLM 的 Session 归档有两点与 Agent / Environment 相反，必须照抄而非照抄先例：

- **前置状态检查**：非 `running` 才可归档，违反返回 409（一期恒 `idle`，此分支待二期生效）。
- **重复归档返回 409 `session_archived`，不是幂等成功**。受影响 0 行时需重读区分三种情况：不存在（404）、已归档（409）、running（409）。

归档后：读取仍可；列表默认**排除**已归档会话（`include_archived=true` 才包含——这一点也与 Agent / Environment 列表「恒包含」不同）；更新与新增 / 删除挂载均返回 409。

### 删除（硬删除，级联挂载记录）

```
batch:
  1. DELETE FROM session_resources WHERE session_id = ?
  2. DELETE FROM session_outputs WHERE session_id = ?   ← 先删映射(FK 顺序)
  3. DELETE FROM files WHERE id IN (产出 fileIds,删除前先行查出)
  4. DELETE FROM sessions WHERE id = ? AND status != 'running'
```

受影响 0 行时重读区分 404 / 409（running）。已归档会话允许删除。挂载的 File 本体是独立资源不随会话删除（R2 对象与 `files` 行都保留），只是挂载记录消失、File 随之解除引用、恢复可删。**产出的 File 相反：生命周期从属于会话**，连行带 R2 对象一起清（R2 清理在 batch 成功后尽力执行，失败留孤儿对象不影响正确性）；被其他会话挂载的产出被删时留下悬空挂载，物化读取以 null-continue 防御。

### 资源挂载 / 卸载

```
挂载: INSERT INTO session_resources (…)
      前置: session 存在(404)、未归档(409)、file_id 存在(400)、
            mount_path 归一化通过(400)、与既有挂载不重叠(400)、file 数 < 500(400)
卸载: DELETE FROM session_resources WHERE id = ? AND session_id = ?
      前置: session 存在(404)、未归档(409)；resource 不存在(404)
```

### mount_path 归一化与重叠判定

GLM 规则：「省略或传 null 时默认为 `/mnt/session/uploads/{file_id}`；路径会归一化到 `/mnt/session/uploads` 下，不能逃逸该目录，UTF-8 总长度不超过 1024 字节」。落地算法（shared 纯函数 `normalizeMountPath`）：

1. 省略 / null → `/mnt/session/uploads/{file_id}`。
2. 绝对路径去掉开头的 `/` 后拼接到 `/mnt/session/uploads/` 下（绝对路径也被视为该根内的路径）；拒绝空串与 `\` 分隔符。
3. 逐段消解 `.` 与 `..`：`..` 越过根即「逃逸」，返回错误 → 400。
4. 结果为 UTF-8 字节数 ≤ 1024 的 POSIX 绝对路径；同一输入归一化结果确定。
5. **重叠判定**：与既有挂载按路径段比较，互为前缀（含相等，`UNIQUE` 约束兜底）即重叠 → 400。允许同一 `file_id` 挂到不同路径，允许不同 `file_id` 挂同级不重叠路径。

## 校验规则（服务层，zod；DB 只保留基本约束）

| 规则 | 来源 |
| --- | --- |
| `agent` 必填（或兼容字段 `agent_id`，两者至少其一）；三种形态：ID 字符串 / `{type:"agent", id, version?}` / `{type:"agent_with_overrides", …}` | GLM wire |
| `environment_id` 匹配 `^env_[0-9a-f-]{36}$`；必须存在且未归档 | 引用一致性 |
| `title` ≤ 256，可为 null | — |
| `metadata` ≤ 16 键，键 ≤ 64 字符，值 ≤ 512 字符 | — |
| `initial_events` ≤ 50；一期非空返回 400 | 一期裁剪 |
| `resources` 合计 ≤ 508 且 `file` ≤ 500；一期 `type` 仅 `file`；`mount_path` 归一化通过且互不重叠 | GLM 上限 + 一期裁剪 |
| `vault_ids` ≤ 20 且不重复；一期非空返回 400 | GLM 上限 + 一期裁剪 |
| 覆盖字段沿用 Agent 配置的全部单字段约束（`model` 枚举、`system` ≤ 100000、`tools` ≤ 128、`skills` ≤ 20、`mcp_servers` ≤ 20），校验作用于解析后的最终配置 | 复用 Agent 规则 |
| 更新请求 `minProperties: 1`（空体 400）；`agent` 内只允许 `tools` / `mcp_servers` 且至少其一 | GLM wire |
| 列表：`agent_version` 必须与 `agent_id` 同用；`statuses[]` 取四个枚举值；`created_at[gt/gte/lt/lte]` 为合法 RFC 3339；`memory_store_id` 一期提供即 400 | — |

## Drizzle 定义（落地到 `packages/db/src/schema.ts`）

```ts
import { index, integer, sql, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/**
 * Session 当前态:单表无版本;agent_config / environment_snapshot 是创建时固化的
 * 解析快照(status 一期恒 idle,事件与运行时属二期)。
 * type / vault_ids / outcome_evaluations / stats / budget 是一期固定回显,不落库。
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sess_ + UUIDv7
    agentId: text("agent_id").notNull(),
    agentVersion: integer("agent_version").notNull(),
    agentConfig: text("agent_config", { mode: "json" })
      .$type<unknown>()
      .notNull(),
    environmentId: text("environment_id").notNull(),
    environmentSnapshot: text("environment_snapshot", { mode: "json" })
      .$type<unknown>()
      .notNull(),
    status: text("status")
      .$type<"idle" | "running" | "rescheduling" | "terminated">()
      .notNull()
      .default("idle"),
    title: text("title"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadInputTokens: integer("cache_read_input_tokens").notNull().default(0),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_sessions_created_at_id").on(t.createdAt, t.id),
    index("idx_sessions_agent_version").on(t.agentId, t.agentVersion, t.createdAt, t.id),
  ],
);

/**
 * 会话挂载的 File 资源(一期仅 file,列为 memory_store 预留)。
 * file_id 是软引用,写入时校验存在;挂载记录随会话删除级联清理,File 本体不删。
 */
export const sessionResources = sqliteTable(
  "session_resources",
  {
    id: text("id").primaryKey(), // sres_ + UUIDv7
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    type: text("type")
      .$type<"file">()
      .notNull()
      .default("file"),
    fileId: text("file_id").notNull(),
    mountPath: text("mount_path").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("idx_session_resources_session").on(t.sessionId, t.createdAt, t.id),
    index("idx_session_resources_file_id").on(t.fileId),
    unique("uq_session_resources_mount_path").on(t.sessionId, t.mountPath),
  ],
);
```

`$type<…>` 的具体类型（`SessionAgentConfig` 等）由 `@nano/shared` 的 zod schema 推导后回填，保证 DB 与 API 类型同源。

## 对既有模块的回填

引入本设计后，[File 模块](../files/schema.md)预留的三处联动随之生效（实现排期见 [work-plan.md](work-plan.md) 的收尾里程碑）：

1. `DELETE /v1/files/{fileId}` 增加引用检查：被**未归档**会话挂载的 File 拒绝删除，返回 400（参照 Skill 模块「活动引用即阻止」先例）；已归档会话的挂载不阻止删除。
2. `GET /v1/files` 的 `scope_id` 过滤从「校验 `sess_` 前缀后恒返回空页」变为真实过滤（按 `session_resources.file_id` 反查挂载会话）。
3. File 响应补 `scope` 字段回显。

## 约定

- **时间戳**：DB 存 `timestamp_ms` 整数；API 输出 ISO 8601 UTC（`2026-09-12T08:00:00.000Z`）。
- **固定回显字段**：`type: "session"`、`vault_ids: []`（一期）、`outcome_evaluations: []`、`budget: null` 与 `agent.multiagent: null` 不落库，序列化时注入；`stats` 自 M4 落库回读（`active_seconds` / `duration_seconds` 两列,运行时随 turn 终局回写，见 runtime.md §8）。
- **无事件端点**：GLM 的 `POST/GET /v1/sessions/:id/events` 与 SSE 流属二期（`SESSION_DO`，设计见 [runtime.md](runtime.md)），本设计的表结构不为其预留列。
- **分页游标**：列表按 `(created_at, id)` keyset（带 `agent_id` 过滤时走 agent 复合索引同序），游标 base64url 编码经 `next_page` 返回，opaque；一期不提供 GLM 的 `prev_page` 双向游标。
