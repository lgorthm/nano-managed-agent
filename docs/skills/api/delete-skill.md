# 删除 Skill

> 删除指定 Skill 及其全部版本与文件内容（硬删除）。被活动配置（未归档 Agent 的当前版本快照）引用时返回 400；删除成功返回 `{id, type}` 回执。

## 请求示例

```bash
curl -sS -X DELETE "http://127.0.0.1:8787/v1/skills/skill_01911111-2222-7333-8444-555555555555" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "skill_01911111-2222-7333-8444-555555555555",
  "type": "skill_deleted"
}
```

删除范围是该 Skill 的全部版本（含 `latest_version` 指向的最新版本）与全部文件行，三张表在一个事务里级联删除。删除前做引用检查：只要任何**活动配置**（未归档 Agent 的当前版本快照）的 `skills[]` 引用了该 Skill 的任意版本，就返回 400。解除引用（更新 Agent 移除该 Skill 引用，或归档 Agent）后即可删除；历史版本快照中的引用不阻止删除。

与 Agent 的「无删除、归档即终止」不同，Skill 的终止操作就是硬删除；不存在即 404，重复删除同样 404（删除不是幂等回执，与归档的幂等语义不同）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 被活动配置（未归档 Agent 的当前版本快照）引用 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | `skillId` 不存在（含已删除后重复删除） |

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
  - name: Skill
    description: 自定义 Skill 与版本管理。
paths:
  /v1/skills/{skillId}:
    delete:
      tags: [Skill]
      summary: 删除 Skill
      description: >-
        删除指定 Skill 及其全部版本与文件内容。被活动配置（未归档 Agent 的当前版本快照）引用时返回 400，解除引用或归档 Agent 后可删。
      operationId: deleteSkill
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: skillId
          in: path
          required: true
          description: Skill 资源标识。
          schema:
            type: string
            example: skill_01911111-2222-7333-8444-555555555555
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SkillDeleted'
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
    SkillDeleted:
      type: object
      properties:
        id:
          type: string
          description: 被删除的 Skill ID。
        type:
          type: string
          enum: [skill_deleted]
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
      description: API Key 配置在 Worker 环境变量 API_KEY 中。
````
