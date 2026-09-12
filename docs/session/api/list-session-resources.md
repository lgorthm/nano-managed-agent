# 列出 Session 资源

> 列出指定 Session 挂载的全部 File Resource，按挂载时间倒序、keyset 游标分页。归档后的会话仍可列出其资源。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/resources?limit=20" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "data": [
    {
      "id": "sres_01911111-4444-7444-8444-444444444444",
      "type": "file",
      "file_id": "file_01911111-5555-7555-8555-555555555555",
      "mount_path": "/mnt/session/uploads/datasets/q2-sales.csv",
      "created_at": "2026-09-12T08:30:00.000Z",
      "updated_at": "2026-09-12T08:30:00.000Z"
    }
  ],
  "next_page": null
}
```

分页参数 `limit` / `order` / `page` 与 [README.md](README.md#分页) 的统一约定一致（默认按挂载时间 `desc`）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `limit < 1`、`order` 非法、`page` 游标无效 |
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
  - url: https://nano-api.example.workers.dev
    description: 生产 Worker（以实际部署域名为准）
security:
  - bearerAuth: []
tags:
  - name: Session
    description: Session 与资源挂载。
paths:
  /v1/sessions/{sessionId}/resources:
    get:
      tags: [Session]
      summary: 列出 Session 资源
      description: 列出指定 Session 挂载的全部 File Resource，按挂载时间倒序、keyset 游标分页。归档后的会话仍可列出。
      operationId: listSessionResources
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          description: sessionId 资源标识。
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
          description: 排序方向（按挂载时间）；默认 desc。
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
                $ref: '#/components/schemas/SessionResourcePage'
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
    SessionResourcePage:
      type: object
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/FileResourceResponse'
        next_page:
          type: string
          nullable: true
          description: 下一页游标；null 表示没有更多数据。
      required: [data, next_page]
      additionalProperties: false
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
