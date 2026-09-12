# 获取 Session

> 获取指定 Session 的配置、状态、固化的 Agent 快照、挂载资源与用量。归档后的会话仍可读取。无读取权限时与资源不存在时均返回 404（单租户下即不存在 → 404）。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "sess_01911111-3333-7333-8333-333333333333",
  "type": "session",
  "agent": {
    "id": "agent_01911111-1111-7111-8111-111111111111",
    "type": "agent",
    "name": "Coding Assistant",
    "model": { "id": "glm-5.3", "effort": "max", "speed": "standard" },
    "system": "You are a helpful coding agent.",
    "description": null,
    "tools": [
      {
        "type": "agent_toolset_20260601",
        "default_config": {
          "enabled": true,
          "permission_policy": { "type": "always_allow" }
        },
        "configs": []
      }
    ],
    "skills": [],
    "mcp_servers": [],
    "multiagent": null,
    "version": 3
  },
  "environment_id": "env_01911111-2222-7222-8222-222222222222",
  "status": "idle",
  "title": "Data analysis session",
  "metadata": {},
  "resources": [],
  "vault_ids": [],
  "outcome_evaluations": [],
  "stats": { "active_seconds": 0, "duration_seconds": 0 },
  "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0 },
  "budget": null,
  "created_at": "2026-09-12T08:00:00.000Z",
  "updated_at": "2026-09-12T08:00:00.000Z",
  "archived_at": null
}
```

值得关注的运行时字段：`status`（当前真实状态；nano 一期恒 `idle`）、`usage`（累计 input / output / cache_read token，一期恒 0）、`resources`（挂载的 File，含实际 `mount_path`）、`agent`（创建时固化的解析快照，非 Agent 当前配置）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
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
  /v1/sessions/{sessionId}:
    get:
      tags: [Session]
      summary: 获取 Session
      description: 获取指定 Session 的配置、状态、固化的 Agent 快照、挂载资源与用量。归档后的会话仍可读取。
      operationId: getSession
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
          description: 请求成功。
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
      description: 完整字段与嵌套结构（SessionAgentResponse 等）见 create-session.md；此处列一级字段。
      type: object
      properties:
        id:
          type: string
          example: sess_01911111-3333-7333-8333-333333333333
        type:
          type: string
          enum: [session]
        agent:
          type: object
          description: 创建时固化的 Agent 配置快照（钉住版本 ⊕ 会话级覆盖）。
        environment_id:
          type: string
        status:
          type: string
          enum: [idle, running, rescheduling, terminated]
          description: nano 一期恒为 idle。
        title:
          type: string
          nullable: true
        metadata:
          type: object
          additionalProperties:
            type: string
        resources:
          type: array
          description: 挂载的 File 资源（含实际 mount_path）。
          items:
            type: object
        vault_ids:
          type: array
          items:
            type: string
          description: nano 一期恒为空数组。
        outcome_evaluations:
          type: array
          items:
            type: object
        stats:
          type: object
          properties:
            active_seconds:
              type: number
            duration_seconds:
              type: number
        usage:
          type: object
          properties:
            input_tokens:
              type: integer
            output_tokens:
              type: integer
            cache_read_input_tokens:
              type: integer
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
