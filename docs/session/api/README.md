# Session API

nano-managed-agent 的 Session 资源接口，请求 / 响应结构与 GLM Managed Agents（`zai-version: 2026-05-26`）保持一致。
表结构设计见 [../schema.md](../schema.md)，代码结构见 [../structure.md](../structure.md)。

Session 是一次会话运行的控制面记录：创建时把 Agent（钉住版本 ⊕ 会话级覆盖）与 Environment（配置快照）固化进会话，可挂载 File 资源供沙箱使用。nano 一期只实现元数据控制面——事件收发、SSE 推流与 Agent 循环属二期运行时（见文末「二期预留」），因此一期会话创建后停留在 `idle`，`status` 的其余枚举值与相关 409 门禁为二期就位预留。

## 端点（10）

| 文档 | 端点 |
| --- | --- |
| [list-sessions.md](list-sessions.md) | `GET /v1/sessions` |
| [create-session.md](create-session.md) | `POST /v1/sessions` |
| [get-session.md](get-session.md) | `GET /v1/sessions/{sessionId}` |
| [update-session.md](update-session.md) | `POST /v1/sessions/{sessionId}` |
| [archive-session.md](archive-session.md) | `POST /v1/sessions/{sessionId}/archive` |
| [delete-session.md](delete-session.md) | `DELETE /v1/sessions/{sessionId}` |
| [add-session-file-resource.md](add-session-file-resource.md) | `POST /v1/sessions/{sessionId}/resources` |
| [list-session-resources.md](list-session-resources.md) | `GET /v1/sessions/{sessionId}/resources` |
| [get-session-file-resource.md](get-session-file-resource.md) | `GET /v1/sessions/{sessionId}/resources/{resourceId}` |
| [delete-session-file-resource.md](delete-session-file-resource.md) | `DELETE /v1/sessions/{sessionId}/resources/{resourceId}` |

## 通用约定

- **Base URL**：本地 dev `http://127.0.0.1:8787`；生产为 Worker 域名（如 `https://nano-api.<account>.workers.dev`）。
- **认证**：所有请求携带 `Authorization: Bearer <API_KEY>`。本地 dev 的 key 配在 `apps/api/.dev.vars`。
- **内容类型**：请求与响应均为 `application/json; charset=utf-8`。
- **时间戳**：ISO 8601 UTC（`2026-09-12T08:00:00.000Z`）。
- **资源标识**：`sessionId` 形如 `sess_01911111-3333-7333-8333-333333333333`，挂载资源 `resourceId` 形如 `sres_01911111-4444-7444-8444-444444444444`（前缀 + UUIDv7）。

## 错误信封

所有非 2xx 响应使用统一结构（结构与 GLM 一致；`request_id` 由 Worker 生成，可用于日志追踪）：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "resources[0].file_id references a file that does not exist",
    "details": { "param": "resources[0].file_id" }
  },
  "request_id": "req_01J..."
}
```

`error.type` 取值：`invalid_request_error` / `authentication_error` / `permission_error` / `not_found_error` / `request_too_large` / `rate_limit_error` / `api_error` / `timeout_error` / `overloaded_error`。

409 冲突（更新非 idle 会话的工具、归档 running / 已归档会话、删除 running 会话）的 `error.type` 为 `invalid_request_error`，语义标记（`session_not_idle` / `session_archived`）体现在 message 中——与 Agent 模块版本冲突的处理一致。

## 分页

`list-sessions` 与 `list-session-resources` 使用统一分页参数：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | integer ≥ 1 | 20 | 每页数量；大于 100 时服务端截断为 100 |
| `order` | `asc` / `desc` | `desc` | 排序方向（按创建时间） |
| `page` | string | — | 上一页响应返回的 opaque 游标 |

响应为 `{ "data": [...], "next_page": string | null }`；`next_page` 为 null 表示没有更多数据，翻页时把它作为下一页的 `page` 传入。游标内容对客户端不透明，不要解析或修改。

**注意**：列表默认**排除已归档会话**，`include_archived=true` 才包含——这一点与 nano 的 Agent / Environment 列表（恒包含已归档）不同，与 GLM Session 语义一致。

## 与 GLM Managed Agents 的差异

除下表所列，各端点的路径形状、请求 / 响应 schema、更新与归档语义均与 GLM 一致：

| 项 | GLM | nano |
| --- | --- | --- |
| 路径前缀 | `/agent/managed/v1/sessions` | `/v1/sessions` |
| 协议头 | 必须携带 `zai-version` / `zai-beta` | 不需要（协议版本由路径 `/v1` 携带） |
| 服务地址 | `https://agent-api.bigmodel.cn/api` | 本地 dev / 自有 Worker 域名 |
| 创建状态码 | `200` | `201`（沿用 nano 各资源创建端点惯例） |
| 事件端点 | `POST/GET …/events`、`GET …/events/stream`（SSE） | 二期（见下节）；`initial_events` 非空一期返回 400 |
| `x-events-encrypted` / `x-checkpoint` | 创建时开关，事件按客户密钥加密 / 检查点 | 一期忽略（无事件存储） |
| `status` 迁移 | idle / running / rescheduling / terminated 全量 | wire 保留全部枚举，一期恒 `idle`；running 门禁照常实现 |
| `resources` 类型 | `file` + `memory_store` | 一期仅 `file`（无 Memory Store 资源），`memory_store` 返回 400 |
| `vault_ids` | ≤ 20 个 Vault 引用 | 一期恒 `[]`，非空返回 400（无 Vault 资源） |
| `stats` / `outcome_evaluations` | 运行时统计 | 一期固定 `{active_seconds: 0, duration_seconds: 0}` / `[]` |
| `budget` | 恒 `null`（平台未支持） | 同 GLM，恒 `null` |
| 列表过滤 | `memory_store_id` 可用 | 一期提供即 400（无 Memory Store 资源） |
| 双向游标 | 响应含 `prev_page`，支持向前翻页 | 一期仅 `next_page` 向后翻页（nano 统一分页约定） |
| 归档非幂等 | 重复归档 409 `session_archived` | 与 GLM 一致（特别提醒：与 nano Agent / Environment 的幂等归档**不同**） |
| 非 API 创建会话 | IM 渠道会话不可归档 / 删除（409） | 不适用（nano 只有 API 创建的会话） |
| 环境归档联动 | 归档环境触发引用会话准入终止 | 一期无运行时无联动；创建时校验环境未归档已实现 |

## 二期预留：事件与运行时

GLM 的会话工作流是「先开 SSE 流、再发消息、会话进入 running、结束后回到 idle」。nano 把这一侧整体划入二期：事件历史与 SSE 推流落在 `SESSION_DO` Durable Object，Agent 循环由 `agent-loop` Workflow 驱动（架构见 [architecture-diagrams.md](../../architecture-diagrams.md)，绑定已在 `apps/api/wrangler.jsonc` 注释预留）。届时：

- 新增 `POST /v1/sessions/{sessionId}/events`（发送事件，触发执行）、`GET …/events`（检索事件历史）、`GET …/events/stream`（SSE 订阅）三个端点，`docs/session/api/` 补对应文档；
- `status` 由运行时驱动迁移，`usage` 三列开始累计，`stats` 变为真实统计；
- `initial_events` 放开（删除创建 schema 的一期拒绝分支），`x-events-encrypted` 一并设计；
- 本页十个端点的契约不变。
