# Session 模块实现计划

本计划依据 [structure.md](structure.md) 定下的三层结构与目录布局，把 Session 模块的实现拆成九个里程碑：一个地基阶段、六个按接口竖切的阶段、一个挂载资源阶段、一个回填收尾阶段。每个竖切阶段交付可以实际调用、带完整测试的端点，对应 `docs/session/api/` 下的一份接口文档。

## 总体思路

**按接口竖切，骨架靠既有模块复制。** Session 是第五个资源模块，`modules/session` 的骨架（routes、handlers、service、serialize）直接照 Agent 模块复制；本模块真正的新东西是跨资源引用解析与挂载路径语义，两者都先以 `@nano/shared` 纯函数加 node 单测的形式钉死，再进集成。

**顺序有依赖考量。** 创建接口第一，负责立骨架与最重的引用解析链路；获取、列表互相独立可并行；更新依赖创建产出的会话行（无变化检测、409 分支都要既有行才可测）；归档与删除放在更新后（归档的 409 回归、删除的级联回归都依赖先能更新）；挂载资源放在会话生命周期完整之后（挂载门禁依赖归档语义）；回填收尾最后，改动 file 模块的行为必须有 Session 的全量行为做回归基线。

**三处反直觉语义要靠测试守住。** Session 有三处与仓库既有先例相反、实现时最容易照抄出错的行为，每个相关里程碑的测试都必须显式断言：① 归档**非幂等**（重复归档 409，Agent / Environment 是幂等成功）；② 列表**默认排除**已归档（Agent / Environment 恒包含）；③ 归档会话**可删除**（与「已归档即终态不可动」的直觉相反）。

## 里程碑总览

| 里程碑 | 交付能力 | 对应接口文档 | 规模 |
| --- | --- | --- | --- |
| M0 地基 | 两张表与迁移就绪，协议层纯函数与单测就绪 | — | 中 |
| M1 创建 | `POST /v1/sessions` | [create-session.md](api/create-session.md) | 大 |
| M2 获取 | `GET /v1/sessions/{sessionId}` | [get-session.md](api/get-session.md) | 小 |
| M3 列表 | `GET /v1/sessions` | [list-sessions.md](api/list-sessions.md) | 中 |
| M4 更新 | `POST /v1/sessions/{sessionId}` | [update-session.md](api/update-session.md) | 大 |
| M5 归档 | `POST /v1/sessions/{sessionId}/archive` | [archive-session.md](api/archive-session.md) | 小 |
| M6 删除 | `DELETE /v1/sessions/{sessionId}` | [delete-session.md](api/delete-session.md) | 小 |
| M7 挂载资源 | 四个 `/resources` 端点 | [add-session-file-resource.md](api/add-session-file-resource.md) 等 4 篇 | 中 |
| M8 回填与收尾 | file 模块联动回填，全量验收 | 全部 | 中 |

依赖关系：M2 与 M3 互相独立可并行；M5 与 M6 可对调（M6 的级联删除不依赖 M5）；M7 依赖 M5（已归档挂载门禁的 409 用例需要先能归档）：

```
M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7 → M8
          └────────┘（可并行）      └ M5/M6 可对调 ┘
```

## 通用工作约定

与 Agent 计划相同，适用于每个里程碑，后文不再重复：

- **完成定义（DoD）**：`pnpm typecheck` 与 `pnpm test` 全绿；本里程碑新增测试全部通过；接口行为对照对应文档的「错误行为」表与请求 / 响应示例逐条核对；`pnpm dev` 起本地服务后用 curl 冒烟通过。
- **提交粒度**：一个里程碑至少一个提交；M1、M4 建议按 shared → db → api 分成三个提交。
- **迁移纪律**：改 `packages/db/src/schema.ts` 必须紧接着 `pnpm db:generate` 并提交。
- **测试先行部分**：涉及 `@nano/shared` 纯函数（resolve、mount-path）的任务，先写单测用例清单再写实现。

---

## M0 地基

不产出业务端点：表就位、纯函数语义钉死，后续竖切不再为基础设施分心。

**存储层：**

- [x] 在 `packages/db/src/schema.ts` 中按 [schema.md](schema.md#drizzle-定义落地到-packagedbsrctschemats) 写入 `sessions` 与 `session_resources` 两张表（含三索引与 `UNIQUE (session_id, mount_path)`）；JSON 列 `$type<>()` 先用宽松类型占位，M1 回填 shared 推导类型。
- [x] 跨模块仓储补齐：`agent/repo.ts` 加 `findAgentVersion(db, agentId, version)`（点查指定版本行）与读取最新版本号的出口；`environment/repo.ts` 补按 id 读取（如未导出）；`file/repo.ts` 补 `findFilesByIds`。
- [x] 新建 `packages/db/src/session/ids.ts`：`newSessionId()` / `newSessionResourceId()`（`sess_` / `sres_` + 复用 `../uuid.ts`）。
- [x] `pnpm db:generate` 生成迁移，`pnpm db:migrate:local` 本地跑通。

**协议层（纯函数先行）：**

- [x] 新建 `packages/shared/src/session/schemas.ts`：创建 / 更新请求、列表过滤参数、Session 与 SessionResource 响应的全部 schema 与 `z.infer` 类型。一期裁剪以 refine 分支实现（`initial_events` / `vault_ids` 非空拒绝、`resources[].type` 仅 `file`），schema 主体与 GLM 形状一致；`agent` / `agent_id` 的 anyOf 用 union + superRefine。
- [x] 新建 `packages/shared/src/session/resolve.ts`：`resolveSessionAgent(versionConfig, overrides)` —— 字段级整体替换（省略继承、null 与空数组清空），输出全具体值的最终配置（复用 agent 模块的 normalize 设施做补全）。
- [x] 新建 `packages/shared/src/session/mount-path.ts`：`normalizeMountPath(input, fileId)` 与 `overlapsAny(candidate, existing)`，算法按 [schema.md](schema.md#mount_path-归一化与重叠判定)。
- [x] 单测三件：`schemas.test.ts`（三形态、一期裁剪、anyOf 至少其一、minProperties）；`resolve.test.ts`（省略 / null / 空数组 / 整体替换的穷举组合）；`mount-path.test.ts`（默认路径、`..` 消解与逃逸、1024 字节边界、相等 / 包含 / 兄弟路径的重叠判定、反斜杠与空串拒绝）。

**验收：**

- [x] `pnpm typecheck`、`pnpm test`（shared 单测）全绿；本地 D1 能看到两张表。

---

## M1 创建 Session — `POST /v1/sessions`

第一片竖切，除了实现创建接口，还负责立 `modules/session` 骨架与最重的跨资源引用解析链路。

**存储层：**

- [x] `packages/db/src/session/repo.ts`：实现 `createSession(db, { session, resources })`——`sessions` 行与 N 条 `session_resources` 行放同一个 D1 batch。
- [x] 把 schema.ts 中 JSON 列占位类型回填为 shared 推导的具体类型。

**传输层：**

- [x] 建立 `apps/api/src/modules/session/` 骨架：`routes.ts`（声明 `POST /v1/sessions`）、`serialize.ts`（行转 API JSON：`type` / `vault_ids` / `outcome_evaluations` / `stats` / `budget` / `agent.type` / `agent.multiagent` 注入，`resources` 由子查询拼装）、`service.ts`（首个方法 `createSession`，判定链按 structure.md：agent 三形态解析 → 版本存在性（404 / 400 分界，400 附最新版本提示）→ `resolveSessionAgent` + 最终配置校验 → skills 引用存在性 → environment 存在与未归档（404 / 400 分界）→ 资源校验（file 存在、mount_path 归一化、互不重叠、≤ 500）→ 单 batch 落库）、`handlers/create-session.ts`。
- [x] `routes/v1.ts` 挂载 `v1.route("/sessions", sessionRoutes)`。

**测试与验收：**

- [x] 集成测试 `create-session.test.ts`：最小请求（agent 字符串 + environment_id）返回 201，响应逐字段对照文档示例（`status: "idle"`、`vault_ids: []`、`stats` 全 0、`usage` 全 0、`budget: null`、agent 快照回显钉住版本）；`{type:"agent", version: 3}` 钉版本生效（`agent.version === 3`，即使 Agent 已升到更高版本）；`agent_with_overrides` 覆盖 system 后 `agent.system` 为覆盖值且 Agent 本体不变；钉不存在版本返回 400 且 message 含当前最新版本；agent 不存在 404、environment 不存在 404、environment 已归档 400（helpers 直改库造归档）；`resources` 省略 mount_path 回显默认路径、显式相对路径回显归一化绝对路径、两条重叠路径 400、`file_id` 不存在 400、`type: "memory_store"` 400；`initial_events` 非空 400、`vault_ids` 非空 400；两个都缺（agent 与 agent_id）400；不带凭证 401。
- [x] curl 冒烟：按文档「请求示例」原样创建一次，肉眼比对响应。

---

## M2 获取 Session — `GET /v1/sessions/{sessionId}`

- [x] `repo.ts` 加 `findSession(db, sessionId)`（单行点查）；`service.ts` 加 `getSession`（null → 404）；`handlers/get-session.ts` 并注册路由。
- [x] 集成测试 `get-session.test.ts`：创建后按返回 id 获取，字段与创建响应完全一致；挂载了资源的会话 `resources` 数组完整回显；归档后（helpers 直改库）仍可读取且 `archived_at` 非空；不存在的 id 404；path 参数为任意合法字符串不 500；不带凭证 401。

---

## M3 列出 Session — `GET /v1/sessions`

本里程碑的新增重点在过滤参数解析（`statuses[]` 重复参数与 `created_at[*]` 区间是列表端点首次出现）。

- [x] `repo.ts` 加 `listSessionsPage(db, filters)`：`agent_id` / `agent_version` / `statuses[]` / `created_at` 区间 / `include_archived` 组合过滤 + `(created_at, id)` keyset；带 `agent_id` 时走 `idx_sessions_agent_version` 同序扫描。
- [x] service / handler / 序列化：`{ data, next_page }`；游标 payload 带类型前缀（防与其他列表端点混用，复用 `lib/pagination.ts` 约定）。
- [x] 集成测试 `list-sessions.test.ts`：默认按创建时间倒序、默认**排除**已归档（反直觉点①显式断言）、`include_archived=true` 包含；`agent_id` 过滤、`agent_id + agent_version` 过滤（会话钉的是创建时版本，Agent 后续升级不影响命中）；`agent_version` 单独出现 400；`statuses[]` 单个与重复传参；`created_at[gte]` / `[lt]` 组合；`memory_store_id` 提供 400；游标翻页与篡改游标 400；`limit` 截断与 `order=asc`。

---

## M4 更新 Session — `POST /v1/sessions/{sessionId}`

语义最重的里程碑：分字段更新规则、冻结字段拒绝、无变化检测、409 分支。

**协议层（先行）：**

- [x] `schemas.ts` 补 `SessionUpdateRequest`：顶层与 `agent` 均 `minProperties: 1`、`.strict()`（冻结字段出现即 400）；`MetadataPatch` 值可为 null 表示删键（形态同 Agent 的 patch）。

**存储层：**

- [x] `repo.ts` 加 `updateSessionRow(db, { sessionId, patch, now })`：守卫式 `UPDATE … WHERE id = ? AND archived_at IS NULL`，0 行返回 false。

**传输层：**

- [x] `service.ts` 加 `updateSession`：取行（null → 404）→ 已归档 → 409 → `agent.tools` / `agent.mcp_servers` 存在且 `status != idle` → 409（一期不可达，照常实现）→ 合并（title 替换、metadata 按键合并、`resolveSessionAgent(currentConfig, patch.agent)` 整体替换）→ 替换后最终配置校验 mcp 映射 → 无变化检测（不写库、`updated_at` 不变）→ 守卫式写入，false 时重读区分 404 / 409。
- [x] `handlers/update-session.ts` 并注册路由。

**测试与验收：**

- [x] 集成测试 `update-session.test.ts`：只改 title；title 传 null 清空；metadata 合并 / 删键 / 保留；`agent.tools` 整体替换后 `session.agent.tools` 回显新值且 Agent 本体不变；替换后 `mcp_toolset` 与 `mcp_servers` 不一一对应 400；提交 `model` / `system` / `skills` / `vault_ids` / `environment_id` / `resources` 任一冻结字段 400；空对象 400、`agent: {}` 400；提交与现状完全相同的 title + metadata + tools 不写库（`updated_at` 不变）；已归档会话更新 409（反直觉点②的回归入口）；不存在的 id 404。
- [x] curl 冒烟：按文档示例更新一次并核对回显。

---

## M5 归档 Session — `POST /v1/sessions/{sessionId}/archive`

- [x] `repo.ts` 加 `archiveSession(db, sessionId, now)`：`WHERE archived_at IS NULL AND status != 'running'`，0 行返回 false。
- [x] `service.ts` 加 `archiveSession`：false 时重读分诊——不存在 404、已归档 409（`session_archived`）、running 409。
- [x] `handlers/archive-session.ts` 并注册路由。
- [x] 集成测试 `archive-session.test.ts`：归档成功 `archived_at` 填充；**重复归档返回 409（非幂等，反直觉点②，与 agent 归档测试形成对照注释）**；归档后 `GET` 仍可读、`GET /resources` 仍可读；列表默认不出现、`include_archived=true` 出现；归档后更新 409（M4 的端到端回归）；不存在的 id 404。

---

## M6 删除 Session — `DELETE /v1/sessions/{sessionId}`

- [x] `repo.ts` 加 `deleteSession(db, sessionId)`：同一 batch 先删 `session_resources` 再删 `sessions`（`WHERE status != 'running'`），0 行返回 false；service 重读分诊 404 / 409。
- [x] `handlers/delete-session.ts` 并注册路由。
- [x] 集成测试 `delete-session.test.ts`：响应 `{id, type: "session_deleted"}`；删除后 GET 404、重复删除 404；**已归档会话可以删除（反直觉点③）**；挂载了资源的会话删除后 `session_resources` 清空（helpers 直查库断言）、被挂载的 File 仍可 GET 与下载；不存在的 id 404。

---

## M7 挂载资源 — 四个 `/resources` 端点

- [x] `repo.ts` 加 `insertSessionResource` / `listSessionResourcesPage` / `findSessionResource` / `deleteSessionResource`（`findSessionResource` / `deleteSessionResource` 以 `{sessionId, resourceId}` 为条件——跨会话 resourceId 视为不存在）。
- [x] service 加四个方法：挂载前置链（会话 404 → 已归档 409 → file 存在 400 → 归一化 400 → 重叠 400 → ≤ 500）；卸载前置链（会话 404 → 已归档 409 → resource 404）。四个 handler 与路由注册。
- [x] 集成测试 `session-resources.test.ts`（四端点共享夹具，合并一个文件）：挂载省略 mount_path 得默认路径、相对路径归一化回显、`..` 逃逸 400、与既有挂载前缀重叠 400、兄弟路径不重叠成功、同一 file 不同路径允许、`file_id` 不存在 400、`memory_store` 400、达 500 上限 400；已归档会话挂载 / 卸载 409；列表分页与排序；单查不属于该会话的 resourceId 404；卸载响应 `{id, type: "session_resource_deleted"}`、重复卸载 404；卸载后 File 不受影响。

---

## M8 回填与收尾

**file 模块回填**（[files schema.md](../files/schema.md#与-session-的联动预留) 承诺的三处）：

- [x] `file/repo.ts` / service：`delete-file` 增加引用检查——`countSessionFileMounts(fileId)` 以「未归档会话」为条件计数，非零返回 400（message 指明挂载会话）；已归档会话的挂载不阻止删除。
- [x] `list-files` 的 `scope_id` 过滤真实化：`findSessionIdsByFileId` 反查；File 响应补 `scope` 字段回显。file 既有测试补两个用例：被未归档会话挂载的 file 删除 400；归档该会话后删除成功。

**全量验收：**

- [x] 对照十份接口文档做系统核对：响应字段与 OpenAPI required 一致；固定回显字段（`type` / `vault_ids` / `outcome_evaluations` / `stats` / `budget`）在所有响应恒定；错误信封在所有非 2xx 格式一致且带 `request_id`。
- [x] curl 走一遍完整生命周期：创建（钉版本 + 覆盖 + 挂载）→ 获取 → 列表（含过滤与游标）→ 更新（title / metadata / tools，含一次冻结字段 400）→ 卸载一个资源 → 归档 → 重复归档（409）→ 删除，全程对照文档示例。
- [x] 全量 `pnpm test` 与 `pnpm typecheck`；迁移在全新本地库从零应用成功。
- [x] 复查依赖规则：`modules/session` 无横向 import（跨资源读取全部经各模块 repo）；`runtime/` 目录本期不创建。

---

## 风险与注意事项

- **三处反直觉语义**（见总体思路）：重复归档 409、列表默认排除已归档、已归档可删除。实现与测试都要与 Agent / Environment 的先例显式对照，code review 时最容易被「照抄旧模块」带偏。
- **`agent_config` 的读-改-写没有 CAS**：Session wire 无 version 字段，并发更新最后写入获胜（同 Environment 先例）。集成测试无法真并发，用「先读、直改库、再提交」模拟即可，但 service 不得假设读到的行在提交时仍然有效——一切以守卫式 UPDATE 的返回为准。
- **404 / 400 的分界**：顶层引用（agent、environment）不存在 → 404；配置内引用（version、file_id）不存在 → 400；environment 存在但已归档 → 400。这三条在 M1 测试中逐条断言，不要在 service 里混用一个「引用不存在」错误。
- **mount_path 重叠的并发窗口**：检查-后-插入之间另一请求插入重叠路径时，服务层检查会漏；`UNIQUE (session_id, mount_path)` 只兜底「完全相同」。前缀包含类竞争窗口一期接受（单租户、低并发），在插入冲突（SQLITE_CONSTRAINT）时转 400 而不是 500。
- **`statuses[]` 的解析**：Hono / query 解析器对重复参数的取法（`statuses[]` 命名 + explode 形态）与 GLM 一致，注意单值与多值两种提交都要兼容。
- **游标防混用**：sessions 与 session-resources 两个列表端点的游标 payload 带类型前缀，防止互串（同 Agent 计划的约定）。
