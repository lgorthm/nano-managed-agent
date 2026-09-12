# 列出 Session

> 按创建时间倒序列出当前身份的 Session。支持按 Agent / 版本 / 状态 / 创建时间过滤。默认排除已归档会话，`include_archived=true` 时包含——这一点与 nano 的 Agent / Environment 列表（恒包含已归档）不同，与 GLM Session 语义一致。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions?agent_id=$AGENT_ID&statuses[]=idle&statuses[]=running&limit=20" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "data": [
    {
      "id": "sess_01911111-3333-7333-8333-333333333333",
      "type": "session",
      "agent": { "id": "agent_01911111-1111-7111-8111-111111111111", "type": "agent", "…": "固化的配置快照" },
      "environment_id": "env_01911111-2222-7222-8222-222222222222",
      "status": "idle",
      "title": "Data analysis session",
      "metadata": {},
      "resources": [],
      "vault_ids": [],
      "outcome_evaluations": [],
      "stats": { "active_seconds": 0, "duration_seconds": 0 },
      "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0 },
      "budget": null,
      "created_at": "2026-09-12T08:00:00.000Z",
      "updated_at": "2026-09-12T08:00:00.000Z",
      "archived_at": null
    }
  ],
  "next_page": null
}
```

`data` 中每个条目的完整结构同 [get-session.md](get-session.md)。

## 过滤参数

| 参数 | 说明 |
| --- | --- |
| **agent_id** / **agent_version** | 按 Agent 过滤（匹配会话钉住的版本）；`agent_version` 必须与 `agent_id` 同用，否则 400。 |
| **statuses[]** | 可重复传入的状态过滤，如 `statuses[]=idle&statuses[]=running`；取值必须为四个枚举之一。 |
| **created_at[gt] / [gte] / [lt] / [lte]** | 按创建时间过滤，值为 RFC 3339（如 `created_at[gte]=2026-09-01T00:00:00Z`），四个参数可组合；非法时间返回 400。 |
| **include_archived** | 默认 `false`；`true` 时包含已归档会话。 |
| **memory_store_id** | GLM 支持按挂载的 Memory Store 过滤；nano 无 Memory Store 资源，提供该参数返回 400。 |
| **limit** / **order** / **page** | 分页：`limit` 默认 20、大于 100 截断为 100；`order` 默认 `desc`（按创建时间）；`page` 用响应的 `next_page` 向后翻页。 |

nano 一期不提供 GLM 的 `prev_page` 双向游标（见 [README.md](README.md#分页) 的差异说明）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `agent_version` 未与 `agent_id` 同用、`statuses[]` 非法枚举、`created_at` 边界非法、`memory_store_id` 提供、`limit < 1`、`order` 非法、`page` 游标无效 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |

## OpenAPI

````yaml
openapi: 3.0.1
info:
  title: nano-managed-agent API
  version: 1.0.0
servers:
  - url: http://127.0.0.1:8787
    description: 本地 dev server
  - url: https://nano-api.example.workers.dev
    description: 生产 Worker（以实际部署域名为准）
security:
  - bearerAuth: []
tags:
  - name: Session
    description: Session 与资源挂载。
paths:
  /v1/sessions:
    get:
      tags: [Session]
      summary: 列出 Session
      description: >-
        按创建时间倒序列出 Session，支持按 Agent / 版本 / 状态 / 创建时间过滤。默认排除已归档会话，
        include_archived=true 时包含。nano 一期不支持 memory_store_id 过滤（400）与 prev_page 双向游标。
      operationId: listSessions
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: agent_id
          in: query
          required: false
          description: 按 Agent ID 过滤（匹配会话钉住的版本）。
          schema:
            type: string
        - name: agent_version
          in: query
          required: false
          description: 配合 agent_id 过滤版本；必须与 agent_id 同用。
          schema:
            type: integer
        - name: statuses[]
          in: query
          required: false
          description: 可重复传入的 Session 状态过滤。
          schema:
            type: array
            items:
              type: string
              enum: [idle, running, rescheduling, terminated]
          style: form
          explode: true
        - name: 'created_at[gt]'
          in: query
          required: false
          description: 创建时间下界（RFC 3339，开区间）。
          schema:
            type: string
            format: date-time
        - name: 'created_at[gte]'
          in: query
          required: false
          description: 创建时间下界（RFC 3339，闭区间）。
          schema:
            type: string
            format: date-time
        - name: 'created_at[lt]'
          in: query
          required: false
          description: 创建时间上界（RFC 3339，开区间）。
          schema:
            type: string
            format: date-time
        - name: 'created_at[lte]'
          in: query
          required: false
          description: 创建时间上界（RFC 3339，闭区间）。
          schema:
            type: string
            format: date-time
        - name: include_archived
          in: query
          required: false
          description: 是否包含已归档 Session；默认 false。
          schema:
            type: boolean
            default: false
        - name: memory_store_id
          in: query
          required: false
          description: nano 无 Memory Store 资源，提供该参数返回 400。
          schema:
            type: string
        - name: limit
          in: query
          required: false
          description: 每页数量；默认 20，大于 100 时服务端截断为 100。
          schema:
            type: integer
            minimum: 1
            default: 20
        - name: order
          in: query
          required: false
          description: 排序方向（按创建时间）；默认 desc。
          schema:
            type: string
            enum: [asc, desc]
            default: desc
        - name: page
          in: query
          required: false
          description: 上一页响应返回的 opaque 游标。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SessionPage'
        default:
          description: 请求失败。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
components:
  parameters:
    Authorization:
      name: Authorization
      in: header
      required: true
      description: 'Bearer <API_KEY>；本地 dev 的 key 配在 apps/api/.dev.vars。'
      schema:
        type: string
        example: 'Bearer nsk-...'
  schemas:
    SessionPage:
      type: object
      properties:
        data:
          type: array
          items:
            type: object
            description: Session 对象，完整结构见 create-session.md / get-session.md。
        next_page:
          type: string
          nullable: true
          description: 下一页游标；null 表示没有更多数据。
      required: [data, next_page]
      additionalProperties: false
    ErrorResponse:
      type: object
      properties:
        type:
          type: string
          enum: [error]
        error:
          type: object
          properties:
            type:
              type: string
            message:
              type: string
            details:
              type: object
              additionalProperties: true
          required: [type, message]
          additionalProperties: false
        request_id:
          type: string
      required: [type, error, request_id]
      additionalProperties: false
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: 标准 HTTP Bearer 认证；API Key 配置在 Worker 环境变量 API_KEY 中。
````
