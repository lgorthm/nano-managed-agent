# File API

nano-managed-agent 的 File 资源接口，请求 / 响应结构与 GLM Managed Agents（`zai-version: 2026-05-26`）保持一致。
表结构设计见 [../schema.md](../schema.md)。

File 是独立资源：上传后不可变（无更新端点），删除是唯一生命周期变更；与 Session 的挂载关系（GLM 的 Session Resource）经 `/v1/sessions/{sessionId}/resources` 管理（见 [../schema.md](../schema.md#与-session-的联动) 与 [../session/api/](../session/api/README.md)），被未归档会话挂载的 File 不可删除。

## 端点（5）

| 文档 | 端点 |
| --- | --- |
| [upload-file.md](upload-file.md) | `POST /v1/files` |
| [list-files.md](list-files.md) | `GET /v1/files` |
| [get-file.md](get-file.md) | `GET /v1/files/{fileId}` |
| [download-file.md](download-file.md) | `GET /v1/files/{fileId}/content` |
| [delete-file.md](delete-file.md) | `DELETE /v1/files/{fileId}` |

## 通用约定

- **Base URL**：本地 dev `http://127.0.0.1:8787`；生产为 Worker 域名（如 `https://nano-api.<account>.workers.dev`）。
- **认证**：所有请求携带 `Authorization: Bearer <API_KEY>`。本地 dev 的 key 配在 `apps/api/.dev.vars`。
- **内容类型**：上传端点请求为 `multipart/form-data`；下载端点响应为文件原始字节（`content-type` 取存储的 `mime_type`）；其余请求与响应均为 `application/json; charset=utf-8`。
- **时间戳**：ISO 8601 UTC（`2026-09-11T08:00:00.000Z`）。
- **资源标识**：`fileId` 形如 `file_01911111-3333-7444-8555-666666666666`（`file_` + UUIDv7）。
- **固定字段**：`type` 恒为 `file`；`downloadable` 恒为 `true`（保留 wire 兼容）；`scope` 仅在按 `scope_id` 过滤列出时回显挂载会话，租户级列表不输出。

## 上传与限制

- 请求体为 `multipart/form-data`，恰好一个必需文件字段 `file`（binary）；出现未知字段或多于一个文件字段返回 400。
- `filename` 取 part 的原始文件名，1–256 字符，原样存储与回显。
- `mime_type` 取 part 的 Content-Type 并去参数（如 `text/plain; charset=utf-8` 存为 `text/plain`）；缺失或无法解析时为 `application/octet-stream`。
- 单文件 ≤ 50 MiB（52,428,800 字节），超限返回 `413 request_too_large`。
- **上传成功状态码为 200**（GLM 的上传端点即返回 200，与本库 create 类端点的 201 不同）。

## 错误信封

所有非 2xx 响应使用与 Agent API 相同的结构（`request_id` 由 Worker 生成，可用于日志追踪），`error.type` 取值见 [Agent API README](../../agent/api/README.md#错误信封)：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "multipart request must contain exactly one file field",
    "details": { "param": "file" }
  },
  "request_id": "req_01J..."
}
```

## 分页

`list-files` 使用与 Agent / Skill API 相同的分页参数（`limit` 默认 20、大于 100 截断为 100；`order` 为 `asc` / `desc`，默认 `desc`；`page` 为 opaque 游标），响应为 `{ "data": [...], "next_page": string | null }`。排序键 `(created_at, id)`。

另支持 `scope_id` 过滤参数（GLM 按 Session scope 过滤）：必须为 `sess_` 前缀，否则 400；返回被该会话挂载的 File（每条回显 `scope: {type: "session", id}`），会话不存在或无挂载时自然返回空页。

## 下载行为

`GET /v1/files/{fileId}/content` 的响应头由存储的元数据决定，不随实际内容嗅探变化：

- `content-type`：存储的 `mime_type`。
- `content-disposition`：`attachment; filename="<filename>"`；文件名含非 ASCII 字符时按 RFC 5987 追加 `filename*=UTF-8''…`。
- `etag`：上传时记录的对象 ETag；内容不可变因此 ETag 稳定，可安全用于条件请求与缓存。

## 与 GLM Managed Agents 的差异

除下表所列，各端点的路径形状、请求 / 响应 schema、删除行为均与 GLM 一致：

| 项 | GLM | nano |
| --- | --- | --- |
| 路径前缀 | `/agent/managed/v1/files` | `/v1/files` |
| 协议头 | 必须携带 `zai-version` / `zai-beta` | 不需要（协议版本由路径 `/v1` 携带） |
| 服务地址 | `https://agent-api.bigmodel.cn/api` | 本地 dev / 自有 Worker 域名 |
| 列表分页 | `limit` / `before_id` / `after_id`（limit ≤ 1000），响应 `{data, has_more, first_id, last_id}` | 全站约定 `limit` / `order` / `page`（limit > 100 截断），响应 `{data, next_page}`（与 Agent / Skill API 一致） |
| Session scope | `scope` 字段与 `scope_id` 过滤 | `scope_id` 过滤返回该会话挂载的 File 并回显 `scope`；租户级列表不输出 `scope` |
| 删除保护 | 被 Session 引用等场景返回错误 | 被未归档会话挂载的 File 返回 400；归档会话的挂载不阻止删除（见 [../schema.md](../schema.md#与-session-的联动)） |
| 文件大小上限 | 平台限制，未公开数值 | 单文件 ≤ 50 MiB，超限 413 |
| 下载响应头 | 仅说明媒体类型与文件名由元数据决定 | 同左，并补充 `etag` 响应头（上传时记录，稳定可缓存） |
| 资源可见性 | 本人创建 + 访问桥授权 | 一期单租户，不做授权共享 |
