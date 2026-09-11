# 下载 Skill ZIP

> 下载指定 Skill Version 的完整目录内容（ZIP），用于检查或复用该不可变版本。ZIP 以版本的 `directory` 为唯一根目录，条目按路径排序、时间戳固定，同一版本的任意两次下载字节一致。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/skills/skill_01911111-2222-7333-8444-555555555555/versions/2/content" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -o pdf-tools-v2.zip
```

响应 `200`，`content-type: application/zip`，响应头另有：

```
content-disposition: attachment; filename="pdf-tools-v2.zip"
etag: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

解压后的目录结构：

```
pdf-tools/
├── SKILL.md
└── scripts/
    ├── extract_text.py
    └── extract_tables.py
```

- 根目录名即版本元数据的 `directory`（上传带单根前缀时为该前缀名，否则等于 frontmatter `name`）。
- `etag` 为落库时计算的规范树哈希（`content_sha256`）；ZIP 字节确定（条目按 path 字典序、mtime 恒为版本 `created_at`），ETag 因此稳定，可安全用于条件请求与缓存。
- `version` 路径参数的合法形态同 [get-skill-version.md](get-skill-version.md)。

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
  /v1/skills/{skillId}/versions/{version}/content:
    get:
      tags: [Skill]
      summary: 下载 Skill ZIP
      description: >-
        下载指定 Skill Version 的 ZIP 内容。ZIP 以版本的 directory 为唯一根目录，条目按路径排序、时间戳固定，同一版本的任意两次下载字节一致；etag 为规范树哈希。
      operationId: downloadSkillZip
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
          description: Skill 目录的 ZIP 内容。
          headers:
            content-disposition:
              schema:
                type: string
                example: attachment; filename="pdf-tools-v2.zip"
            etag:
              schema:
                type: string
                description: 规范树哈希（content_sha256）。
          content:
            application/zip:
              schema:
                type: string
                format: binary
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
