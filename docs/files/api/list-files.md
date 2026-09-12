# 列出 File

> 分页列出当前身份可读取的 File（仅元数据，不含内容）。支持 `limit` / `order` / `page` 游标翻页；`scope_id` 过滤参数一期恒返回空页（见 [README.md](README.md#分页)）。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/files?limit=20&order=desc" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "data": [
    {
      "id": "file_01911111-3333-7444-8555-666666666666",
      "type": "file",
      "size_bytes": 1048576,
      "created_at": "2026-09-11T08:00:00.000Z",
      "filename": "report.pdf",
      "mime_type": "application/pdf",
      "downloadable": true
    }
  ],
  "next_page": null
}
```

- 分页参数与全站约定一致（`limit` 默认 20、大于 100 截断为 100；`order` 默认 `desc`，即最新上传的在前；`page` 为上一页返回的 opaque 游标），详见 [README.md](README.md#分页)。nano 实现按 `(created_at, id)` keyset 排序，游标对客户端 opaque。
- `scope_id`：必须为 `sess_` 前缀，否则 400；一期无 Session 资源与 session-scoped 文件，传入时恒返回 `{"data": [], "next_page": null}`。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `limit` 小于 1、`order` 非法、`page` 游标无效、`scope_id` 非 `sess_` 前缀 |
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
  - name: File
    description: Managed Files 上传、读取与删除。
paths:
  /v1/files:
    get:
      tags: [File]
      summary: 列出 File
      description: >-
        分页列出当前身份可读取的 File（仅元数据，不含内容）。支持 limit / order / page 游标翻页；scope_id
        过滤参数一期恒返回空页。
      operationId: listFiles
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: limit
          in: query
          required: false
          description: 每页数量；大于 100 时服务端截断为 100。
          schema:
            type: integer
            minimum: 1
            default: 20
        - name: order
          in: query
          required: false
          description: 排序方向（按上传时间）。
          schema:
            type: string
            enum: [asc, desc]
            default: desc
        - name: page
          in: query
          required: false
          description: 上一页返回的 opaque cursor。
          schema:
            type: string
        - name: scope_id
          in: query
          required: false
          description: 按 Session scope 过滤，必须为 sess_ 前缀；一期无 Session 资源，传入时恒返回空页。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/FilePage'
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
    FilePage:
      type: object
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/File'
        next_page:
          type: string
          nullable: true
      required: [data, next_page]
      additionalProperties: false
    File:
      type: object
      properties:
        type:
          type: string
          enum: [file]
        id:
          type: string
          description: File ID。
          example: file_01911111-3333-7444-8555-666666666666
        size_bytes:
          type: integer
          format: int64
          description: 内容字节数。
        created_at:
          type: string
          format: date-time
          description: 上传时间。
        filename:
          type: string
          description: 上传时的原始文件名，原样回显。
        mime_type:
          type: string
          description: 归一化后的 media type（去参数）。
        downloadable:
          type: boolean
          description: 当前恒为 true；保留字段以对齐 GLM wire-format。
      required: [type, id, size_bytes, created_at, filename, mime_type, downloadable]
      additionalProperties: false
      example:
        id: file_01911111-3333-7444-8555-666666666666
        type: file
        size_bytes: 1048576
        created_at: '2026-09-11T08:00:00.000Z'
        filename: report.pdf
        mime_type: application/pdf
        downloadable: true
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
              enum:
                - invalid_request_error
                - authentication_error
                - permission_error
                - not_found_error
                - request_too_large
                - rate_limit_error
                - api_error
                - timeout_error
                - overloaded_error
            message:
              type: string
            details:
              type: object
              additionalProperties: true
          required: [type, message]
          additionalProperties: false
        request_id:
          type: string
          example: req_01J...
      required: [type, error, request_id]
      additionalProperties: false
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: 标准 HTTP Bearer 认证；API Key 配置在 Worker 环境变量 API_KEY 中。
````
