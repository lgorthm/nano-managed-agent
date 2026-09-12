# 删除 Session File Resource

> 解除指定 Session 的一个 File 挂载。只能作用于未归档的 Session。File 本体是独立资源，卸载不影响 File 的存储与可读性，也不影响 File 被其他会话挂载。

## 请求示例

```bash
curl -sS -X DELETE "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/resources/$RESOURCE_ID" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{ "id": "sres_01911111-4444-7444-8444-444444444444", "type": "session_resource_deleted" }
```

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Session 不存在，或该 Session 名下无此 resourceId（含重复删除） |
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
  - url: https://nano-api.example.workers.dev
    description: 生产 Worker（以实际部署域名为准）
security:
  - bearerAuth: []
tags:
  - name: Session
    description: Session 与资源挂载。
paths:
  /v1/sessions/{sessionId}/resources/{resourceId}:
    delete:
      tags: [Session]
      summary: 删除 Session File Resource
      description: >-
        解除指定 Session 的一个 File 挂载；只能作用于未归档的 Session。File 本体不随卸载删除。
      operationId: deleteSessionFileResource
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          description: sessionId 资源标识。
          schema:
            type: string
        - name: resourceId
          in: path
          required: true
          description: 挂载资源标识（sres_ 前缀）。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SessionResourceDeleted'
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
    SessionResourceDeleted:
      type: object
      properties:
        id:
          type: string
          description: 被解除的挂载资源 ID。
          example: sres_01911111-4444-7444-8444-444444444444
        type:
          type: string
          enum: [session_resource_deleted]
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
