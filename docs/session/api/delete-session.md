# 删除 Session

> 永久移除 Session 及其挂载记录，不可恢复。会话必须处于非 `running` 状态（否则 409）；已归档会话允许删除。挂载的 File 是独立资源，不随会话删除——只是挂载记录消失、File 随之解除引用、恢复可删。事件历史在 nano 一期尚不存在（属二期 `SESSION_DO`），故当前删除的只有元数据与挂载记录。

## 请求示例

```bash
curl -sS -X DELETE "http://127.0.0.1:8787/v1/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{ "id": "sess_01911111-3333-7333-8333-333333333333", "type": "session_deleted" }
```

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Session 不存在（含重复删除） |
| 409 | `invalid_request_error` | Session 处于 `running`（nano 一期恒 idle，此分支待二期运行时就位后生效） |

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
  /v1/sessions/{sessionId}:
    delete:
      tags: [Session]
      summary: 删除 Session
      description: >-
        永久移除 Session 及其挂载记录，不可恢复。非 running 状态才可删除（否则 409）；已归档会话允许删除。
        挂载的 File 是独立资源，不随会话删除。
      operationId: deleteSession
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          description: sessionId 资源标识。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SessionDeleted'
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
    SessionDeleted:
      type: object
      properties:
        id:
          type: string
          description: 被删除的 Session ID。
          example: sess_01911111-3333-7333-8333-333333333333
        type:
          type: string
          enum: [session_deleted]
      required: [id, type]
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
