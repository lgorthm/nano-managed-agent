# Agent API

nano-managed-agent 的 Agent 资源接口，请求 / 响应结构与 GLM Managed Agents（`zai-version: 2026-05-26`）保持一致。
表结构设计见 [../schema.md](../schema.md)。

## 端点（6）

| 文档 | 端点 |
| --- | --- |
| [list-agent.md](list-agent.md) | `GET /v1/agents` |
| [create-agent.md](create-agent.md) | `POST /v1/agents` |
| [get-agent.md](get-agent.md) | `GET /v1/agents/{agentId}` |
| [update-agent.md](update-agent.md) | `POST /v1/agents/{agentId}` |
| [list-agent-versions.md](list-agent-versions.md) | `GET /v1/agents/{agentId}/versions` |
| [archive-agent.md](archive-agent.md) | `POST /v1/agents/{agentId}/archive` |

## 通用约定

- **Base URL**：本地 dev `http://127.0.0.1:8787`；生产为 Worker 域名（如 `https://nano-api.<account>.workers.dev`）。
- **认证**：所有请求携带 `Authorization: Bearer <API_KEY>`。本地 dev 的 key 配在 `apps/api/.dev.vars`。
- **内容类型**：请求与响应均为 `application/json; charset=utf-8`。
- **时间戳**：ISO 8601 UTC（`2026-08-31T08:00:00.000Z`）。
- **资源标识**：`agentId` 形如 `agent_01911111-1111-7111-8111-111111111111`（`agent_` + UUIDv7）。

## 错误信封

所有非 2xx 响应使用统一结构（结构与 GLM 一致；`request_id` 由 Worker 生成，可用于日志追踪）：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "tools[0].mcp_server_name must match exactly one mcp_servers entry",
    "details": { "param": "tools[0].mcp_server_name" }
  },
  "request_id": "req_01J..."
}
```

`error.type` 取值：`invalid_request_error` / `authentication_error` / `permission_error` / `not_found_error` / `request_too_large` / `rate_limit_error` / `api_error` / `timeout_error` / `overloaded_error`。

## 分页

`list-agent` 与 `list-agent-versions` 使用同一套分页参数：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | integer ≥ 1 | 20 | 每页数量；大于 100 时服务端截断为 100 |
| `order` | `asc` / `desc` | `desc` | 排序方向（按创建时间 / 版本号） |
| `page` | string | — | 上一页响应返回的 opaque 游标 |

响应为 `{ "data": [...], "next_page": string | null }`；`next_page` 为 null 表示没有更多数据，翻页时把它作为下一页的 `page` 传入。游标内容对客户端不透明，不要解析或修改。

## 与 GLM Managed Agents 的差异

除下表所列，各端点的路径形状、请求 / 响应 schema、更新语义、版本与归档行为均与 GLM 一致：

| 项 | GLM | nano |
| --- | --- | --- |
| 路径前缀 | `/agent/managed/v1/agents` | `/v1/agents` |
| 协议头 | 必须携带 `zai-version` / `zai-beta` | 不需要（协议版本由路径 `/v1` 携带） |
| 服务地址 | `https://agent-api.bigmodel.cn/api` | 本地 dev / 自有 Worker 域名 |
| 归档联动 | 同时归档运行中的 Deployment | 一期无 Deployment 资源，暂无联动 |
| 资源可见性 | 本人创建 + 访问桥授权 | 一期单租户，不做授权共享 |
