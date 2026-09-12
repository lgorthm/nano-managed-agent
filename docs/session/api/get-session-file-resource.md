# 获取 Session File Resource

> 获取指定 Session 挂载的单个 File Resource（含归一化后的 mount_path）。归档后的会话仍可读取。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/resources/$RESOURCE_ID" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "sres_01911111-4444-7444-8444-444444444444",
  "type": "file",
  "file_id": "file_01911111-5555-7555-8555-555555555555",
  "mount_path": "/mnt/session/uploads/datasets/q2-sales.csv",
  "created_at": "2026-09-12T08:30:00.000Z",
  "updated_at": "2026-09-12T08:30:00.000Z"
}
```

`resourceId` 必须属于路径中的 `sessionId`；资源存在但挂在他会话名下同样返回 404。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Session 不存在，或该 Session 名下无此 resourceId |

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
    get:
      tags: [Session]
      summary: 获取 Session File Resource
      description: 获取指定 Session 挂载的单个 File Resource（含归一化后的 mount_path）。resourceId 必须属于该 Session。
      operationId: getSessionFileResource
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
                $ref: '#/components/schemas/FileResourceResponse'
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
    FileResourceResponse:
      type: object
      properties:
        id:
          type: string
          description: 挂载资源 ID（sres_ 前缀）。
          example: sres_01911111-4444-7444-8444-444444444444
        type:
          type: string
          enum: [file]
        file_id:
          type: string
        mount_path:
          type: string
          description: 归一化后的挂载路径。
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
      required: [id, type, file_id, mount_path, created_at, updated_at]
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
