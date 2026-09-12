# 下载 File 内容

> 下载指定 File 的原始二进制内容。响应的媒体类型与文件名由上传时保存的元数据决定，`etag` 为上传时记录的对象 ETag——内容不可变，ETag 稳定，可安全用于条件请求与缓存。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/files/file_01911111-3333-7444-8555-666666666666/content" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -o report.pdf
```

响应 `200`，`content-type: application/pdf`，响应头另有：

```
content-disposition: attachment; filename="report.pdf"
etag: "8f14e45fceea167a5a36dedd4bea2543"
```

- `content-type` 恒为元数据中的 `mime_type`（上传时归一化），不随实际内容嗅探变化。
- `content-disposition` 为 `attachment; filename="<filename>"`；文件名含非 ASCII 字符时按 RFC 5987 追加 `filename*=UTF-8''…`。
- 响应体由对象存储流式透传，Worker 不全量缓冲；上传时的 50 MiB 上限不构成下载瓶颈。

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
  /v1/files/{fileId}/content:
    get:
      tags: [File]
      summary: 下载 File 内容
      description: >-
        下载指定 File 的原始二进制内容。响应的媒体类型和文件名由已保存的文件元数据决定；etag 为上传时记录的对象
        ETag，稳定可缓存。
      operationId: downloadFileContent
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
          description: 文件内容。
          headers:
            content-type:
              description: 恒为元数据中的 mime_type，不随实际内容嗅探变化。
              schema:
                type: string
                example: application/pdf
            content-disposition:
              description: attachment 及原始文件名；非 ASCII 文件名时按 RFC 5987 追加 filename*。
              schema:
                type: string
                example: attachment; filename="report.pdf"
            etag:
              description: 上传时记录的对象 ETag；内容不可变，稳定可缓存。
              schema:
                type: string
                example: '"8f14e45fceea167a5a36dedd4bea2543"'
          content:
            application/octet-stream:
              schema:
                type: string
                format: binary
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
