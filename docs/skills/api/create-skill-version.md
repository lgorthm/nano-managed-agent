# 创建 Skill Version

> 重新上传完整 Skill 目录，为指定 Skill 创建新的不可变版本。上传形态与创建时相同：字段名为 Skill 内相对路径、必须包含顶层 `SKILL.md`；不允许任何文本字段。版本号由服务端单调分配（删除后不复用），并发上传冲突时返回 409。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/skills/skill_01911111-2222-7333-8444-555555555555/versions" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -F "pdf-tools/SKILL.md=@SKILL.md;type=text/markdown" \
  -F "pdf-tools/scripts/extract_text.py=@scripts/extract_text.py" \
  -F "pdf-tools/scripts/extract_tables.py=@scripts/extract_tables.py"
```

响应 `201`：

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

上传成功后 Skill 的 `latest_version` 前移到新版本。每次上传都是完整快照（不 diff、不追加），与 Agent 的数组整体替换语义同理；同一目录重复上传也会生成新版本（无变化不去重）。空壳 Skill（历史版本全部删除、`latest_version` 为 null）可以继续用本端点上载，版本号从分配器当前值继续递增。并发上传时以版本号分配器的 CAS 保证只有一个请求成功，失败方返回 409，重试即可。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 上传形态校验失败（同 [create-skill.md](create-skill.md#错误行为)），另含：请求携带任何文本字段 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | `skillId` 不存在 |
| 409 | `invalid_request_error` | 并发上传导致版本号分配冲突，重试即可 |
| 413 | `request_too_large` | 单文件超 1 MiB 或上传总量超 20 MiB |

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
    post:
      tags: [Skill]
      summary: 创建 Skill Version
      description: >-
        通过 multipart/form-data 重新上传完整 Skill 目录以创建新版本。上传内容必须包含顶层目录中的 SKILL.md，字段名使用 Skill
        内相对路径；不允许任何文本字段。版本号由服务端单调分配，并发冲突返回 409。
      operationId: createSkillVersion
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: skillId
          in: path
          required: true
          description: Skill 资源标识。
          schema:
            type: string
            example: skill_01911111-2222-7333-8444-555555555555
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              properties: {}
              additionalProperties:
                type: string
                format: binary
                description: >-
                  文件字段；字段名为 Skill 内相对路径，必须包含顶层目录下的 SKILL.md。文件数 ≤ 256、单文件 ≤ 1 MiB、总量 ≤ 20 MiB。
      responses:
        '201':
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
