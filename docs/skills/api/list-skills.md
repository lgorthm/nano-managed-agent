# 列出 Skill

> 分页列出当前身份可访问的 Skill（含空壳）。支持按 `source` 过滤，通过 `limit`、`order` 和 `page` 游标翻页。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/skills?limit=20&order=desc&source=custom" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "data": [
    {
      "id": "skill_01911111-2222-7333-8444-555555555555",
      "type": "skill",
      "display_title": "PDF 处理",
      "source": "custom",
      "latest_version": "1",
      "created_at": "2026-09-01T02:00:00.000Z",
      "updated_at": "2026-09-02T06:30:00.000Z"
    }
  ],
  "next_page": null
}
```

分页说明见 [README.md](README.md#分页)。nano 实现按 `(created_at, id)` keyset 排序（默认 `desc`，最新创建的在前）；游标对客户端 opaque。`source=custom` 为 nano 当前唯一有效取值，`source=zai` 返回空页（无平台内置 Skill，见 [README.md](README.md#与-glm-managed-agents-的差异)）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `limit` 小于 1、`order` / `source` 非法或 `page` 游标无效 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |

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
  /v1/skills:
    get:
      tags: [Skill]
      summary: 列出 Skill
      description: 分页列出当前身份可访问的 Skill（含空壳）。支持按 source 过滤，通过 limit、order 和 page 游标翻页。
      operationId: listSkills
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: source
          in: query
          required: false
          description: 按来源过滤；nano 当前仅 custom，zai 返回空页。
          schema:
            type: string
            enum: [custom, zai]
        - name: limit
          in: query
          required: false
          description: 每页数量；大于 100 时服务端截断为 100。
          schema:
            type: integer
            minimum: 1
            default: 20
        - name: order
          in: query
          required: false
          description: 排序方向（按创建时间）。
          schema:
            type: string
            enum: [asc, desc]
            default: desc
        - name: page
          in: query
          required: false
          description: 上一页返回的 opaque cursor。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SkillPage'
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
    SkillPage:
      type: object
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/Skill'
        next_page:
          type: string
          nullable: true
      required: [data, next_page]
      additionalProperties: false
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
          example: '1'
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
