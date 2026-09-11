# 获取 Skill

> 获取指定 Skill 的元数据和最新版本指针。不存在时返回 404（单租户下无「不可见」与「不存在」之分）。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/skills/skill_01911111-2222-7333-8444-555555555555" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "skill_01911111-2222-7333-8444-555555555555",
  "type": "skill",
  "display_title": "PDF 处理",
  "source": "custom",
  "latest_version": "2",
  "created_at": "2026-09-01T02:00:00.000Z",
  "updated_at": "2026-09-02T06:30:00.000Z"
}
```

`latest_version` 指向最新未删除的版本；所有版本被删后为 null（空壳），此时仍可获取 Skill 本体、继续上传新版本。Skill 没有软删除 / 归档状态，不存在即 404、存在即 200。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | `skillId` 不存在 |

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
    get:
      tags: [Skill]
      summary: 获取 Skill
      description: 获取指定 Skill 的元数据和最新版本指针。不存在时返回 404。
      operationId: getSkill
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
                $ref: '#/components/schemas/Skill'
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
    Skill:
      type: object
      properties:
        id:
          type: string
          description: Skill ID。
          example: skill_01911111-2222-7333-8444-555555555555
        type:
          type: string
          enum: [skill]
        display_title:
          type: string
          nullable: true
          description: 展示名；创建后不可修改。
        source:
          type: string
          enum: [custom, zai]
          description: 来源；nano 当前恒为 custom。
        latest_version:
          type: string
          nullable: true
          description: 最新版本号；所有版本被删后为 null（空壳）。
          example: '2'
        created_at:
          type: string
          format: date-time
          description: 创建时间。
        updated_at:
          type: string
          format: date-time
          description: 更新时间（最新版本生成时间或指针变动时间）。
      required:
        - id
        - type
        - display_title
        - source
        - latest_version
        - created_at
        - updated_at
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
