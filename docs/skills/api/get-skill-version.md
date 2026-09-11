# 获取 Skill Version

> 获取指定 Skill Version 的元数据。版本是不可变快照，任何时刻读取结果一致。要获取文件内容请用 [download-skill-zip.md](download-skill-zip.md)。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/skills/skill_01911111-2222-7333-8444-555555555555/versions/2" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "skv_01911111-3333-7444-8555-666666666666",
  "type": "skill_version",
  "skill_id": "skill_01911111-2222-7333-8444-555555555555",
  "version": "2",
  "name": "pdf-processing",
  "description": "从 PDF 文档中提取文本与表格数据，输出结构化结果。",
  "directory": "pdf-tools",
  "created_at": "2026-09-02T06:30:00.000Z"
}
```

`version` 路径参数是十进制数字字符串（`^[1-9][0-9]{0,9}$`）；`"01"`、`"1a"` 这类非法形态返回 400，与「合法但不存在」的 404 区分开。版本被删除后，其版本号不会分配给后续上传，因此 404 永远意味着「该版本从未存在或已被删除」。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `version` 路径参数不是合法的版本号形态 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | `skillId` 不存在，或该版本不存在 / 已删除 |

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
  /v1/skills/{skillId}/versions/{version}:
    get:
      tags: [Skill]
      summary: 获取 Skill Version
      description: 获取指定 Skill Version 的元数据。版本是不可变快照。version 为十进制数字字符串。
      operationId: getSkillVersion
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: skillId
          in: path
          required: true
          description: Skill 资源标识。
          schema:
            type: string
            example: skill_01911111-2222-7333-8444-555555555555
        - name: version
          in: path
          required: true
          description: 版本号；十进制数字字符串。
          schema:
            type: string
            pattern: '^[1-9][0-9]{0,9}$'
            example: '2'
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SkillVersion'
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
