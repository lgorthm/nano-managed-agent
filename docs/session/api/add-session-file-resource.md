# 新增 Session File Resource

> 向未归档的 Session 挂载一个 File Resource。`file_id` 必须存在（不存在返回 400）；`mount_path` 归一化到 `/mnt/session/uploads` 下且不得与现有挂载重叠。nano 一期仅支持 `file` 类型。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/resources" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "type": "file",
    "file_id": "file_01911111-5555-7555-8555-555555555555",
    "mount_path": "datasets/q2-sales.csv"
  }'
```

响应 `201`：

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

## mount_path 归一化规则

1. 省略或传 null → 默认 `/mnt/session/uploads/{file_id}`。
2. 传入路径（相对或绝对）拼接到 `/mnt/session/uploads/` 之下；逐段消解 `.` 与 `..`，`..` 越过根即逃逸，返回 400。
3. 结果为 UTF-8 字节数 ≤ 1024 的 POSIX 绝对路径，响应回显归一化后的值。
4. **重叠判定**：与该会话现有挂载按路径段比较，互为前缀（含相等）即 400。同一 `file_id` 允许挂到不同路径。

每个会话的 `file` 挂载上限 500（含创建时经 `resources` 挂载的），超出返回 400。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `type` 非 `file`、`file_id` 不存在、`mount_path` 逃逸 / 超过 1024 字节 / 与现有挂载重叠、会话 `file` 挂载数达 500 |
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
  - url: https://nano-api.example.workers.dev
    description: 生产 Worker（以实际部署域名为准）
security:
  - bearerAuth: []
tags:
  - name: Session
    description: Session 与资源挂载。
paths:
  /v1/sessions/{sessionId}/resources:
    post:
      tags: [Session]
      summary: 新增 Session File Resource
      description: >-
        向未归档的 Session 挂载一个 File Resource。file_id 必须存在；mount_path 归一化到
        /mnt/session/uploads 下且不得与现有挂载重叠。nano 一期仅支持 file 类型。
      operationId: addSessionFileResource
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          description: sessionId 资源标识。
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/FileResourceInput'
            example:
              type: file
              file_id: file_01911111-5555-7555-8555-555555555555
              mount_path: datasets/q2-sales.csv
      responses:
        '201':
          description: 挂载成功。
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
    FileResourceInput:
      type: object
      properties:
        type:
          type: string
          enum: [file]
          description: 固定为 file；nano 一期不支持其他类型。
        file_id:
          type: string
          minLength: 1
          description: 已存在的 File ID；不存在返回 400。
        mount_path:
          type: string
          nullable: true
          description: >-
            沙箱内挂载路径；省略或传 null 时默认为 /mnt/session/uploads/{file_id}。路径会归一化到
            /mnt/session/uploads 下，不能逃逸该目录，UTF-8 总长度不超过 1024 字节，且不得与现有挂载重叠。
      required: [type, file_id]
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
