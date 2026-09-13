# 获取 File

> 获取指定 File 的元数据，不返回文件二进制内容（内容下载见 [download-file.md](download-file.md)）。无读取权限时与文件不存在时均返回 404。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/files/file_01911111-3333-7444-8555-666666666666" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "file_01911111-3333-7444-8555-666666666666",
  "type": "file",
  "size_bytes": 1048576,
  "created_at": "2026-09-11T08:00:00.000Z",
  "filename": "report.pdf",
  "mime_type": "application/pdf",
  "downloadable": true
}
```

`downloadable` 恒为 `true`。`scope` 字段：会话产出文件恒回显 `{"type": "session", "id": "sess_…"}`（一对一归属）；用户上传的 File 不输出（挂载关系是多对多，仅在 [list-files.md](list-files.md) 的 `scope_id` 过滤时回显）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | File 不存在（无权限与不存在同返回 404） |

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
  /v1/files/{fileId}:
    get:
      tags: [File]
      summary: 获取 File
      description: 获取指定 File 的元数据，不返回文件二进制内容。无读取权限时与文件不存在时均返回 404。
      operationId: getFile
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: fileId
          in: path
          required: true
          description: fileId 资源标识。
          schema:
            type: string
            example: file_01911111-3333-7444-8555-666666666666
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/File'
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
