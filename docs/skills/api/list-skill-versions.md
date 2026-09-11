# 列出 Skill Version

> 分页列出指定 Skill 的历史版本，可使用游标继续读取。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/skills/skill_01911111-2222-7333-8444-555555555555/versions?limit=20&order=desc" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "data": [
    {
      "id": "skv_01911111-3333-7444-8555-666666666666",
      "type": "skill_version",
      "skill_id": "skill_01911111-2222-7333-8444-555555555555",
      "version": "2",
      "name": "pdf-processing",
      "description": "从 PDF 文档中提取文本与表格数据，输出结构化结果。",
      "directory": "pdf-tools",
      "created_at": "2026-09-02T06:30:00.000Z"
    },
    {
      "id": "skv_01911111-2222-7111-8222-444444444444",
      "type": "skill_version",
      "skill_id": "skill_01911111-2222-7333-8444-555555555555",
      "version": "1",
      "name": "pdf-processing",
      "description": "从 PDF 文档中提取文本，输出纯文本结果。",
      "directory": "pdf-tools",
      "created_at": "2026-09-01T02:00:00.000Z"
    }
  ],
  "next_page": null
}
```

分页说明见 [README.md](README.md#分页)。nano 实现按 `version` 数字序 keyset 排序（默认 `desc`，最新版本在前）；游标对客户端 opaque。GLM 的 OpenAPI 未给本端点列分页参数，nano 按全站约定补齐 `limit` / `order` / `page`（见 [README.md](README.md#与-glm-managed-agents-的差异)）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `limit` 小于 1、`order` 非法或 `page` 游标无效 |
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
  /v1/skills/{skillId}/versions:
    get:
      tags: [Skill]
      summary: 列出 Skill Version
      description: 分页列出指定 Skill 的历史版本，可使用游标继续读取。
      operationId: listSkillVersions
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: skillId
          in: path
          required: true
          description: Skill 资源标识。
          schema:
            type: string
            example: skill_01911111-2222-7333-8444-555555555555
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
          description: 排序方向（按版本号数字序）。
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
                $ref: '#/components/schemas/SkillVersionPage'
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
    SkillVersionPage:
      type: object
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/SkillVersion'
        next_page:
          type: string
          nullable: true
      required: [data, next_page]
      additionalProperties: false
    SkillVersion:
      type: object
      properties:
        id:
          type: string
          description: SkillVersion ID。
          example: skv_01911111-3333-7444-8555-666666666666
        type:
          type: string
          enum: [skill_version]
        skill_id:
          type: string
          description: 所属 Skill ID。
        version:
          type: string
          description: 版本号；单调递增整数的十进制字符串，删除后不复用。
          example: '2'
        name:
          type: string
          description: 从 SKILL.md frontmatter 解析的 name。
          example: pdf-processing
        description:
          type: string
          description: 从 SKILL.md frontmatter 解析的 description。
        directory:
          type: string
          description: 目录名；上传带单根前缀时为该前缀名，否则等于 name。下载 ZIP 以它为根目录。
          example: pdf-tools
        created_at:
          type: string
          format: date-time
          description: 版本生成时间。
      required:
        - id
        - type
        - skill_id
        - version
        - name
        - description
        - directory
        - created_at
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
