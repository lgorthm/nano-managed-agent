# 删除 File

> 删除指定 File（元数据与内容）。一期没有 Session 挂载，删除无引用检查、立即生效；不存在或无权限时返回 404。被 Session 引用时的删除保护属二期预留（见 [../schema.md](../schema.md#与-session-的联动预留)）。

## 请求示例

```bash
curl -sS -X DELETE "http://127.0.0.1:8787/v1/files/file_01911111-3333-7444-8555-666666666666" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{ "id": "file_01911111-3333-7444-8555-666666666666", "type": "file_deleted" }
```

- 先删元数据（后续读写立即 404），再尽力清理内容对象；清理失败留下的孤儿对象不影响正确性，删除顺序的理由见 [../schema.md](../schema.md#关键读写流程)。
- 重复删除同一 `fileId` 返回 404（不存在语义）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | File 不存在（含重复删除；无权限与不存在同返回 404） |

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
    delete:
      tags: [File]
      summary: 删除 File
      description: >-
        删除指定 File（元数据与内容）。一期无 Session 挂载，删除无引用检查、立即生效；不存在或无权限时返回
        404。
      operationId: deleteFile
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
                $ref: '#/components/schemas/FileDeleted'
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
    FileDeleted:
      type: object
      properties:
        id:
          type: string
          description: 被删除的 File ID。
          example: file_01911111-3333-7444-8555-666666666666
        type:
          type: string
          enum: [file_deleted]
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
