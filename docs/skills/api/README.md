# Skill API

nano-managed-agent 的 Skill 资源接口，请求 / 响应结构与 GLM Managed Agents（`zai-version: 2026-05-26`）保持一致。
表结构设计见 [../schema.md](../schema.md)，代码结构见 [../structure.md](../structure.md)。

## 端点（9）

| 文档 | 端点 |
| --- | --- |
| [create-skill.md](create-skill.md) | `POST /v1/skills` |
| [list-skills.md](list-skills.md) | `GET /v1/skills` |
| [get-skill.md](get-skill.md) | `GET /v1/skills/{skillId}` |
| [create-skill-version.md](create-skill-version.md) | `POST /v1/skills/{skillId}/versions` |
| [list-skill-versions.md](list-skill-versions.md) | `GET /v1/skills/{skillId}/versions` |
| [get-skill-version.md](get-skill-version.md) | `GET /v1/skills/{skillId}/versions/{version}` |
| [download-skill-zip.md](download-skill-zip.md) | `GET /v1/skills/{skillId}/versions/{version}/content` |
| [delete-skill.md](delete-skill.md) | `DELETE /v1/skills/{skillId}` |
| [delete-skill-version.md](delete-skill-version.md) | `DELETE /v1/skills/{skillId}/versions/{version}` |

## 通用约定

- **Base URL**：本地 dev `http://127.0.0.1:8787`；生产为 Worker 域名（如 `https://nano-api.<account>.workers.dev`）。
- **认证**：所有请求携带 `Authorization: Bearer <API_KEY>`。本地 dev 的 key 配在 `apps/api/.dev.vars`。
- **内容类型**：读取与删除端点为 `application/json; charset=utf-8`；两个创建端点请求为 `multipart/form-data`，下载端点响应为 `application/zip`。
- **时间戳**：ISO 8601 UTC（`2026-09-01T02:00:00.000Z`）。
- **资源标识**：`skillId` 形如 `skill_01911111-2222-7333-8444-555555555555`（`skill_` + UUIDv7）；版本行的 `id` 为 `skv_` 前缀。版本寻址一律用 `(skillId, version)`，`version` 是十进制数字字符串（`"1"`、`"2"`…），路径参数须匹配 `^[1-9][0-9]{0,9}$`。

## 上传形态

`create-skill` 与 `create-skill-version` 的请求体是 `multipart/form-data`：

- **文件字段**：字段名为 Skill 内相对路径（如 `SKILL.md`、`scripts/run.py`）。允许所有文件共享一个包含 `SKILL.md` 的顶层目录前缀（如 `pdf-tools/SKILL.md`），服务端归一化时剥离；归一化后的树必须包含根级 `SKILL.md`。
- **`SKILL.md`**：必须以 YAML frontmatter 开始，提供 `name`（`^[a-z0-9][a-z0-9-]{0,63}$`）与 `description`（1–1024 字符），作为版本元数据落库。
- **文本字段**：`create-skill` 仅允许可选的 `display_title`（≤ 256 字符）；`create-skill-version` 不允许任何文本字段。未知文本字段返回 400。
- **上限**：文件数 ≤ 256（含 `SKILL.md`）、单文件 ≤ 1 MiB、总量 ≤ 20 MiB；超限返回 `413 request_too_large`。路径须为相对路径，长度 ≤ 256 字符，不得含 `..` 段、反斜杠、控制字符或 `.git` 前缀。

## 错误信封

所有非 2xx 响应使用与 Agent API 相同的结构（`request_id` 由 Worker 生成，可用于日志追踪）：

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "upload must contain SKILL.md at the top level",
    "details": { "param": "SKILL.md" }
  },
  "request_id": "req_01J..."
}
```

`error.type` 取值与 [Agent API README](../../agent/api/README.md#错误信封) 相同：`invalid_request_error` / `authentication_error` / `permission_error` / `not_found_error` / `request_too_large` / `rate_limit_error` / `api_error` / `timeout_error` / `overloaded_error`。

## 分页

`list-skills` 与 `list-skill-versions` 使用与 Agent API 相同的分页参数（`limit` 默认 20、大于 100 截断；`order` 为 `asc` / `desc`，默认 `desc`；`page` 为 opaque 游标），响应为 `{ "data": [...], "next_page": string | null }`。

排序键：`list-skills` 按 `(created_at, id)`，`list-skill-versions` 按 `version`（数字序）。`list-skills` 另支持 `source` 过滤参数（`custom` / `zai`）。

## 删除保护

Agent 配置通过 `{type: "custom", skill_id, version}` 引用固定版本的 Skill。被**活动配置**——未归档 Agent 的当前版本快照——引用的 Skill 或 SkillVersion 不可删除，返回 400；解除引用（更新 Agent 移除该 Skill 引用，或归档 Agent）后可删；历史版本快照中的引用不阻止删除。删除最新版本时指针自动落到剩余最大版本，没有剩余时 `latest_version` 为 null（空壳 Skill 仍可继续上传新版本，版本号继续递增、不复用）。

## 与 GLM Managed Agents 的差异

除下表所列，各端点的路径形状、请求 / 响应 schema、版本与删除行为均与 GLM 一致：

| 项 | GLM | nano |
| --- | --- | --- |
| 路径前缀 | `/agent/managed/v1/skills` | `/v1/skills` |
| 协议头 | 必须携带 `zai-version` / `zai-beta` | 不需要（协议版本由路径 `/v1` 携带） |
| 服务地址 | `https://agent-api.bigmodel.cn/api` | 本地 dev / 自有 Worker 域名 |
| Skill 来源 | `custom` 与平台内置 `zai` | 单租户恒为 `custom`；`source=zai` 过滤返回空页，Agent 引用 `type: "zai"` 返回 400 |
| 版本号 | 不透明 string | 单调递增整数的十进制字符串（`"1"`、`"2"`…），删除后不复用 |
| 删除保护范围 | 「被 Agent 配置 / 活动配置引用」，未精确界定 | 未归档 Agent 的当前版本快照（活动配置）引用即阻止；解除引用或归档后可删 |
| 重复上传 | 未定义 | 不去重，每次上传生成新版本；`content_sha256` 用于下载 ETag |
| `list-skill-versions` 分页 | OpenAPI 未列分页参数 | 按全站约定支持 `limit` / `order` / `page` |
| 分页响应 | `ManagedSkillPage` 含 `has_more` | 与 Agent API 一致的 `{data, next_page}`，无 `has_more` |
| 下载响应头 | 仅说明返回 ZIP | 补充 `content-disposition: attachment` 与 `etag`（版本 `content_sha256`），ZIP 字节确定 |
