# Environment API

nano-managed-agent 的 Environment 资源接口，请求 / 响应结构与 GLM Managed Agents（`zai-version: 2026-05-26`）保持一致。
表结构设计见 [../schema.md](../schema.md)，代码结构见 [../structure.md](../structure.md)。

Environment 是会话沙箱的蓝图：声明沙箱中预装的软件包（`packages`）与出网策略（`networking`），创建一次即可在多个会话与定时部署里复用。它不是一台正在运行的机器——配置在创建会话时被固化为该会话的环境快照。

## 端点（6）

| 文档 | 端点 |
| --- | --- |
| [list-environment.md](list-environment.md) | `GET /v1/environments` |
| [create-environment.md](create-environment.md) | `POST /v1/environments` |
| [get-environment.md](get-environment.md) | `GET /v1/environments/{environmentId}` |
| [update-environment.md](update-environment.md) | `POST /v1/environments/{environmentId}` |
| [archive-environment.md](archive-environment.md) | `POST /v1/environments/{environmentId}/archive` |
| [delete-environment.md](delete-environment.md) | `DELETE /v1/environments/{environmentId}` |

## 通用约定

- **Base URL**：本地 dev `http://127.0.0.1:8787`；生产为 Worker 域名（如 `https://nano-api.<account>.workers.dev`）。
- **认证**：所有请求携带 `Authorization: Bearer <API_KEY>`。本地 dev 的 key 配在 `apps/api/.dev.vars`。
- **内容类型**：请求与响应均为 `application/json; charset=utf-8`。
- **时间戳**：ISO 8601 UTC（`2026-09-11T08:00:00.000Z`）。
- **资源标识**：`environmentId` 形如 `env_01911111-2222-7222-8222-222222222222`（`env_` + UUIDv7）。

## 错误信封

所有非 2xx 响应使用统一结构（结构与 GLM 一致；`request_id` 由 Worker 生成，可用于日志追踪）：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "config.networking limited requires allow_package_managers when packages are declared",
    "details": { "param": "config.networking.allow_package_managers" }
  },
  "request_id": "req_01J..."
}
```

`error.type` 取值：`invalid_request_error` / `authentication_error` / `permission_error` / `not_found_error` / `request_too_large` / `rate_limit_error` / `api_error` / `timeout_error` / `overloaded_error`。

## 分页

`list-environment` 使用与 Agent API 相同的分页参数：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `limit` | integer ≥ 1 | 20 | 每页数量；大于 100 时服务端截断为 100 |
| `order` | `asc` / `desc` | `desc` | 排序方向（按创建时间） |
| `page` | string | — | 上一页响应返回的 opaque 游标 |

响应为 `{ "data": [...], "next_page": string | null }`；`next_page` 为 null 表示没有更多数据，翻页时把它作为下一页的 `page` 传入。游标内容对客户端不透明，不要解析或修改。列表包含已归档的 Environment。

## 快照语义（预留）

GLM 中创建会话（Session）时必须引用 `environment_id`，环境的当前配置在那一刻被固化为该会话的环境快照；此后对环境的更新只影响之后创建的会话，正在运行的会话不受影响。归档与删除也通过会话侧生效：归档后仍引用该环境的会话在下一次消费环境的交互时被终止，删除后引用方在下一次使用时得到 not found。

nano 一期尚无 Session 资源，本节描述的联动暂无承载方；接口层的语义（快照固化、只影响新会话）先行与 GLM 对齐，待 Session 模块引入时落地。

## 与 GLM Managed Agents 的差异

除下表所列，各端点的路径形状、请求 / 响应 schema、更新语义、归档与删除行为均与 GLM 一致：

| 项 | GLM | nano |
| --- | --- | --- |
| 路径前缀 | `/agent/managed/v1/environments` | `/v1/environments` |
| 协议头 | 必须携带 `zai-version` / `zai-beta` | 不需要（协议版本由路径 `/v1` 携带） |
| 服务地址 | `https://agent-api.bigmodel.cn/api` | 本地 dev / 自有 Worker 域名 |
| 列表排序参数 | 仅 `limit` / `page` | 增加 `order`（`asc` / `desc`，默认 `desc`），复用 nano 统一分页约定 |
| `scope` | `organization`（组织内共享） | 固定 `organization`（一期单租户，字段仅为 wire 兼容保留） |
| 归档联动 | 终止仍引用它的运行中会话 | 一期无 Session 资源，暂无联动 |
| 快照固化 | 创建会话时固化配置快照 | 待 Session 模块引入后实现（见上节） |
