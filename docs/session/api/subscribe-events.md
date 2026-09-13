# 订阅实时事件

> 通过 Server-Sent Events 订阅指定 Session 的实时事件。该流**只推送连接后的新事件**；重连时应先调用 [list-events.md](list-events.md) 补齐历史并按事件 id 去重。设计见 [../runtime.md](../runtime.md) §7。

## 请求示例

```bash
curl -N "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/events/stream" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

帧形态：

```
: ping                                          ← 心跳注释帧,每 15s(订阅建立时先发一帧)
data: {"id":"sevt_…","type":"user.message","created_at":"…","processed_at":null,"content":[…]}
data: {"id":"sevt_…","type":"session.status_running","created_at":"…","processed_at":"…"}
```

- `data:` 帧的 JSON 与持久化事件同构（信封 + 按 type 展开的载荷）。
- **delta 帧**（`.delta` 后缀类型，仅流上存在、不落库、不出现在列表端点）：`{"type":"agent.message.delta","event_id":"sevt_…","seq":3,"delta":{"text":"…"}}`——增量在前、终事件在后；断线丢增量无害，终事件补全。M1 起随模型流式调用产生（`agent.thinking.delta` / `agent.message.delta`）。

| 参数 | 说明 |
| --- | --- |
| `event_deltas[]` / `event_deltas` | 订阅的 delta 类型，仅 `agent.message` / `agent.thinking`；两种写法合计 ≤ 100，非法值 400。未订阅的客户端只收到终事件，行为自洽 |

背压与上限：每会话订阅数上限 16，超出 429；慢消费者直接断开，客户端按重连协议自愈（列表补历史 + 按 id 去重）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `event_deltas[]` 含非法值或超过 100 项 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Session 不存在 |
| 429 | `rate_limit_error` | 订阅数达上限 |

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
  /v1/sessions/{sessionId}/events/stream:
    get:
      tags: [Session]
      summary: 订阅实时事件
      description: 通过 SSE 订阅指定 Session 的实时事件;只推连接后的新事件,重连先补历史再按 id 去重。
      operationId: streamSessionEvents
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          schema:
            type: string
        - name: event_deltas[]
          in: query
          required: false
          description: 订阅的 delta 类型;可重复传入,与 event_deltas 合计最多 100 项。
          schema:
            type: array
            maxItems: 100
            items:
              type: string
              enum: [agent.message, agent.thinking]
          style: form
          explode: true
        - name: event_deltas
          in: query
          required: false
          description: event_deltas[] 的兼容写法。
          schema:
            type: array
            maxItems: 100
            items:
              type: string
              enum: [agent.message, agent.thinking]
          style: form
          explode: true
      responses:
        '200':
          description: 实时 Session 事件流。
          content:
            text/event-stream:
              schema:
                type: string
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
