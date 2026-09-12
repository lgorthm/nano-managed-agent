# 删除 Environment

> 永久删除指定 Environment。删除不做引用计数：引用方在下一次使用该环境时得到 not found，删除前请确认没有活跃引用。归档与未归档的环境均可删除；不存在时返回 404。

## 请求示例

```bash
curl -sS -X DELETE "http://127.0.0.1:8787/v1/environments/$ENVIRONMENT_ID" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "env_01911111-2222-7222-8222-222222222222",
  "type": "environment_deleted"
}
```

说明：

- 删除是硬终止：资源记录被移除，之后 `GET` / `POST`（更新）/ `POST archive` 均返回 404，列表中不再出现。这与 Agent 不同——Agent 没有 delete 端点，归档即终止；Environment 的归档是「阻止新绑定」的软终止，删除才是移除记录。
- 与 GLM 一致，删除**不做引用计数**：不检查是否有会话 / 部署仍引用该环境。nano 一期没有 Session 资源，此行为暂无联动方；将来 Session 引入后维持同样语义——会话持有创建时固化的环境快照，删除不影响已固化的会话，只影响新会话的创建（引用缺失在那一刻暴露为 not found）。
- 典型操作顺序：先归档观察（新绑定立即被阻止），确认无活跃引用后再删除。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Environment 不存在 |

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
  - name: Environment
    description: 声明式执行环境管理。
paths:
  /v1/environments/{environmentId}:
    delete:
      tags: [Environment]
      summary: 删除 Environment
      description: 永久删除指定 Environment。删除后不能再用于 Session 或 Deployment；不做引用计数，不存在时返回 404。
      operationId: deleteEnvironment
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: environmentId
          in: path
          required: true
          description: environmentId 资源标识。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EnvironmentDeleted'
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
    EnvironmentDeleted:
      type: object
      properties:
        id:
          type: string
          description: 被删除的 Environment ID。
          example: env_01911111-2222-7222-8222-222222222222
        type:
          type: string
          enum: [environment_deleted]
      required:
        - id
        - type
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
