# 归档 Session

> 把 Session 标记为已完成并使其只读。会话必须处于非 `running` 状态（否则 409）。归档后：读取仍可、列表默认排除（`include_archived=true` 才出现）、更新与挂载操作返回 409、删除仍允许。不可逆，没有取消归档端点。

**注意**：与 nano 的 Agent / Environment 归档（幂等成功）不同，Session 的重复归档返回 **409 `session_archived`**——这是 GLM Session 特有语义，nano 照抄。不要按其他资源的先例实现成幂等。

## 请求示例

```bash
curl -sS -X POST "http://127.0.0.1:8787/v1/sessions/$SESSION_ID/archive" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：完整的 Session 对象（结构同 [get-session.md](get-session.md)），`archived_at` 已填充。

```json
{
  "id": "sess_01911111-3333-7333-8333-333333333333",
  "type": "session",
  "archived_at": "2026-09-12T09:30:00.000Z",
  "…": "其余字段与归档前一致"
}
```

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Session 不存在 |
| 409 | `invalid_request_error` | **重复归档**（`session_archived`）；Session 处于 `running`（nano 一期恒 idle，此分支待二期运行时就位后生效） |

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
  /v1/sessions/{sessionId}/archive:
    post:
      tags: [Session]
      summary: 归档 Session
      description: >-
        把 Session 标记为已完成并使其只读。必须处于非 running 状态（否则 409）。重复归档返回 409
        session_archived（非幂等）。归档后仍可读取与删除，列表默认排除。
      operationId: archiveSession
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          description: sessionId 资源标识。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功，返回归档后的完整 Session。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Session'
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
    Session:
      description: 完整字段与嵌套结构见 create-session.md；此处列一级字段。
      type: object
      properties:
        id:
          type: string
        type:
          type: string
          enum: [session]
        agent:
          type: object
        environment_id:
          type: string
        status:
          type: string
          enum: [idle, running, rescheduling, terminated]
        title:
          type: string
          nullable: true
        metadata:
          type: object
        resources:
          type: array
          items:
            type: object
        vault_ids:
          type: array
          items:
            type: string
        outcome_evaluations:
          type: array
          items:
            type: object
        stats:
          type: object
        usage:
          type: object
        budget:
          type: object
          nullable: true
          enum: [null]
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
        archived_at:
          type: string
          nullable: true
          description: 归档时间；本端点成功后为非 null。
      required:
        - id
        - type
        - agent
        - environment_id
        - status
        - title
        - metadata
        - resources
        - outcome_evaluations
        - stats
        - usage
        - vault_ids
        - created_at
        - updated_at
        - archived_at
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
