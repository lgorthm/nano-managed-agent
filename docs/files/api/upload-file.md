# 上传 File

> 通过 `multipart/form-data` 上传一个 File，作为独立资源存储，供后续 Session 挂载或直接下载。请求必须包含 `file` 字段，单文件上限 50 MiB。File 上传后不可变——没有更新端点，删除是唯一生命周期变更。成功状态码为 200（GLM 的上传端点即返回 200，与本库 create 类端点的 201 不同）。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/files" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -F "file=@report.pdf"
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

- 字段规则：`filename` 取 part 的原始文件名（1–256 字符，原样回显）；`mime_type` 取 part 的 Content-Type 并去参数（如 `-F "file=@a.txt;type=text/plain; charset=utf-8"` 存为 `text/plain`；缺失或无法解析时为 `application/octet-stream`）。上传形态与上限详见 [README.md](README.md#上传与限制)。
- 内容写入 R2、元数据写入 D1，写入顺序保证「元数据存在 ⇔ 内容可读」（见 [../schema.md](../schema.md#关键读写流程)）。
- `downloadable` 恒为 `true`；GLM 中可选的 `scope` 字段一期不输出。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 请求不是 `multipart/form-data`；缺 `file` 字段或含多个文件字段；出现未知字段；`filename` 缺失或超 256 字符；空文件（0 字节） |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 413 | `request_too_large` | 单文件超过 50 MiB（52,428,800 字节） |

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
    post:
      tags: [File]
      summary: 上传 File
      description: >-
        通过 multipart/form-data 上传一个 File，作为独立资源存储，供后续 Session
        挂载或直接下载。请求必须包含 file 字段，单文件上限 50 MiB；上传后不可变，成功返回 200。
      operationId: uploadFile
      parameters:
        - $ref: '#/components/parameters/Authorization'
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                file:
                  type: string
                  format: binary
                  description: >-
                    要上传的文件。filename 取 part 的原始文件名（1–256 字符，原样回显）；mime_type 取
                    part 的 Content-Type 并去参数，缺失或无法解析时为 application/octet-stream。
              required: [file]
              additionalProperties: false
      responses:
        '200':
          description: 上传成功。
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
