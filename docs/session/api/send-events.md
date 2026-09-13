# 发送事件

> 向指定 Session 追加事件并触发后续处理。一次可发送 1 至 10 个受支持事件；已归档 Session 不接受新事件。设计见 [../runtime.md](../runtime.md) §4。

M0 运行时的行为：`user.message` 追加后异步触发一轮 **null-turn**（消费输入 → `session.status_running` → `session.usage` → `session.status_idle{stop_reason: end_turn}`，usage 全零）；响应不等 turn 完成，立即返回持久化的输入事件。模型调用与工具执行属 M1/M2。

## 请求示例

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/events" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "events": [
      { "type": "user.message", "content": [{ "type": "text", "text": "分析这份数据" }] }
    ]
  }'
```

响应 `200`：

```json
{
  "data": [
    {
      "id": "sevt_01911111-6666-7666-8666-666666666666",
      "type": "user.message",
      "created_at": "2026-09-12T08:00:00.000Z",
      "processed_at": null,
      "content": [{ "type": "text", "text": "分析这份数据" }]
    }
  ]
}
```

`processed_at` 在排队期间为 `null`，被 turn 消费后回填（[../runtime.md](../runtime.md) §2.1 的唯一可变字段例外）。

## 支持的输入事件（M0）

| type | 载荷 | 说明 |
| --- | --- | --- |
| `user.message` | `content`: 1–20 个 block（text / base64 image / document） | 追加消息；idle 时触发 turn |
| `user.interrupt` | 无 | 置中断标志；M0 无长执行可打断，仅记录事件 |
| `user.tool_confirmation` | `tool_use_id`、`result`(allow/deny)、`deny_message`(仅 deny) | M0 无 always_ask 工具，任何确认返回 400（M3 挂起语义就位后放开） |

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | events 为空 / 超过 10 条；事件类型或 content 非法；allow 携带 deny_message；无待审批项的 tool_confirmation |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Session 不存在 |
| 409 | `invalid_request_error` | Session 已归档（`session_archived`） |

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
    post:
      tags: [Session]
      summary: 发送事件
      description: 向指定 Session 追加 1–10 个输入事件并触发处理；响应不等 turn 完成。
      operationId: sendSessionEvents
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/SendEventsRequest'
      responses:
        '200':
          description: 请求成功，返回持久化的输入事件。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SendEventsResponse'
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
    SendEventsRequest:
      type: object
      properties:
        events:
          type: array
          minItems: 1
          maxItems: 10
          items:
            $ref: '#/components/schemas/EventInput'
      required: [events]
    EventInput:
      oneOf:
        - title: user.message
          type: object
          properties:
            type:
              type: string
              enum: [user.message]
            content:
              type: array
              minItems: 1
              maxItems: 20
              items:
                $ref: '#/components/schemas/ContentBlock'
          required: [type, content]
        - title: user.interrupt
          type: object
          properties:
            type:
              type: string
              enum: [user.interrupt]
          required: [type]
        - title: user.tool_confirmation
          type: object
          properties:
            type:
              type: string
              enum: [user.tool_confirmation]
            tool_use_id:
              type: string
            result:
              type: string
              enum: [allow, deny]
            deny_message:
              type: string
              nullable: true
          required: [type, tool_use_id, result]
    ContentBlock:
      oneOf:
        - title: text
          type: object
          properties:
            type:
              type: string
              enum: [text]
            text:
              type: string
              minLength: 1
          required: [type, text]
        - title: image
          type: object
          properties:
            type:
              type: string
              enum: [image]
            source:
              type: object
              properties:
                type:
                  type: string
                  enum: [base64]
                media_type:
                  type: string
                  enum: [image/jpeg, image/png, image/gif, image/webp]
                data:
                  type: string
              required: [type, media_type, data]
          required: [type, source]
        - title: document
          type: object
          properties:
            type:
              type: string
              enum: [document]
            source:
              oneOf:
                - title: text
                  type: object
                - title: file
                  type: object
            title:
              type: string
              nullable: true
          required: [type, source]
    SendEventsResponse:
      type: object
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/PersistedEvent'
      required: [data]
    PersistedEvent:
      type: object
      description: 事件信封;其余字段由 type 对应载荷决定。
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
