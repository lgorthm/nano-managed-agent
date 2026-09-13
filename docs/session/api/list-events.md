# 列出事件

> 分页读取指定 Session 已持久化的历史事件（存于 `SESSION_DO`，随会话删除一并消失）。可使用游标继续读取，适合在实时流断开后补齐历史。设计见 [../runtime.md](../runtime.md) §2、§7。

与其他列表端点不同：**默认 `limit` 100、默认 `order` asc**（GLM 事件端点语义）。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/events?limit=100&order=asc" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

按类型过滤（可重复传参或逗号分隔，值必须属于事件类型全集，见 [../runtime.md](../runtime.md) §2.3）：

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/events?types[]=session.status_idle&types[]=session.usage" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "data": [
    {
      "id": "sevt_01911111-6666-7666-8666-666666666666",
      "type": "user.message",
      "created_at": "2026-09-12T08:00:00.000Z",
      "processed_at": "2026-09-12T08:00:01.000Z",
      "content": [{ "type": "text", "text": "分析这份数据" }]
    },
    {
      "id": "sevt_01911111-7777-7777-8777-777777777777",
      "type": "session.status_running",
      "created_at": "2026-09-12T08:00:01.000Z",
      "processed_at": "2026-09-12T08:00:01.000Z"
    },
    {
      "id": "sevt_01911111-8888-7888-8888-888888888888",
      "type": "session.status_idle",
      "created_at": "2026-09-12T08:00:02.000Z",
      "processed_at": "2026-09-12T08:00:02.000Z",
      "stop_reason": { "type": "end_turn" }
    }
  ],
  "next_page": null
}
```

| 参数 | 说明 |
| --- | --- |
| `types[]` / `types` | 事件类型过滤（35 项全集枚举），可重复或逗号分隔 |
| `created_at[gt/gte/lt/lte]` | RFC 3339 处理时间边界 |
| `limit` | 默认 100；大于 100 截断为 100 |
| `order` | `asc`（默认）/ `desc` |
| `page` | 上一页返回的 opaque 游标（带 `session-events` 类型前缀，防与其他列表端点混用） |

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | types 含非法枚举值；created_at 边界非法；游标无法解码 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Session 不存在 |

## OpenAPI

````yaml
openapi: 3.0.1
info:
  title: nano-managed-agent API
  version: 1.0.0
servers:
  - url: http://127.0.0.1:8787
    description: 本地 dev server
security:
  - bearerAuth: []
tags:
  - name: Session
paths:
  /v1/sessions/{sessionId}/events:
    get:
      tags: [Session]
      summary: 列出事件
      description: 分页读取指定 Session 已持久化的历史事件。默认 100 条正序。
      operationId: listSessionEvents
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          schema:
            type: string
        - name: types[]
          in: query
          required: false
          description: 事件类型过滤；可重复传入或逗号分隔。
          schema:
            type: array
            items:
              type: string
          style: form
          explode: true
        - name: created_at[gt]
          in: query
          required: false
          schema:
            type: string
            format: date-time
        - name: created_at[gte]
          in: query
          required: false
          schema:
            type: string
            format: date-time
        - name: created_at[lt]
          in: query
          required: false
          schema:
            type: string
            format: date-time
        - name: created_at[lte]
          in: query
          required: false
          schema:
            type: string
            format: date-time
        - name: limit
          in: query
          required: false
          schema:
            type: integer
            minimum: 1
            default: 100
        - name: order
          in: query
          required: false
          schema:
            type: string
            enum: [asc, desc]
            default: asc
        - name: page
          in: query
          required: false
          description: 上一页返回的 opaque cursor。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EventPage'
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
      schema:
        type: string
  schemas:
    EventPage:
      type: object
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/PersistedEvent'
        next_page:
          type: string
          nullable: true
      required: [data, next_page]
    PersistedEvent:
      type: object
      description: 事件信封;其余字段由 type 对应载荷决定(35 项全集见 shared 的 EVENT_TYPES)。
      properties:
        id:
          type: string
        type:
          type: string
        created_at:
          type: string
          format: date-time
        processed_at:
          type: string
          format: date-time
          nullable: true
      required: [id, type, created_at]
      additionalProperties: true
    ErrorResponse:
      type: object
      properties:
        type:
          type: string
          enum: [error]
        error:
          type: object
        request_id:
          type: string
      required: [type, error, request_id]
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
````
