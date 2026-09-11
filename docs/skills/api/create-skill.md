# 创建 Skill

> 通过 `multipart/form-data` 上传一个完整 Skill 目录，创建 Skill 及其首个不可变版本（version = 1）。文件字段的字段名为 Skill 内相对路径，上传内容必须包含顶层目录中的 `SKILL.md`（允许所有文件共享一个顶层目录前缀，服务端归一化时剥离）；可选文本字段 `display_title` 设置展示名，此后不可再改。`SKILL.md` 的 YAML frontmatter 必须提供 `name` 与 `description`，作为版本元数据落库并在响应中回显。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/skills" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -F "display_title=PDF 处理" \
  -F "pdf-tools/SKILL.md=@SKILL.md;type=text/markdown" \
  -F "pdf-tools/scripts/extract_text.py=@scripts/extract_text.py"
```

其中 `SKILL.md` 形如：

```markdown
---
name: pdf-processing
description: 从 PDF 文档中提取文本与表格数据，输出结构化结果。
---

# PDF 处理

按以下步骤处理用户提供的 PDF……
```

响应 `201`：

```json
{
  "id": "skill_01911111-2222-7333-8444-555555555555",
  "type": "skill",
  "display_title": "PDF 处理",
  "source": "custom",
  "latest_version": "1",
  "created_at": "2026-09-01T02:00:00.000Z",
  "updated_at": "2026-09-01T02:00:00.000Z"
}
```

首版本同时生成（`type: "skill_version"`，`version: "1"`），`name` / `description` 取自 frontmatter，`directory` 为被剥离的单根前缀名（无前缀时等于 `name`），可通过 [get-skill-version.md](get-skill-version.md) 查看或 [download-skill-zip.md](download-skill-zip.md) 下载。上传上限与路径规则见 [README.md](README.md#上传形态)：文件数 ≤ 256、单文件 ≤ 1 MiB、总量 ≤ 20 MiB，超限返回 413。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 归一化后根目录缺 `SKILL.md`；frontmatter 缺失、未闭合或 `name` / `description` 非法；路径非法（绝对路径、`..`、反斜杠、控制字符、`.git`）；路径重复；未知文本字段；`display_title` 超 256 字符；文件数超 256 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
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
  /v1/skills:
    post:
      tags: [Skill]
      summary: 创建 Skill
      description: >-
        通过 multipart/form-data 上传一个完整 Skill 目录，创建 Skill 及其首个不可变版本（version = 1）。上传内容必须包含顶层目录中的
        SKILL.md，字段名使用 Skill 内相对路径。SKILL.md 的 YAML frontmatter 必须提供 name 与 description。
      operationId: createSkill
      parameters:
        - $ref: '#/components/parameters/Authorization'
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              properties:
                display_title:
                  type: string
                  maxLength: 256
                  description: 可选展示名；仅创建时可设置。
              additionalProperties:
                type: string
                format: binary
                description: >-
                  文件字段；字段名为 Skill 内相对路径，必须包含顶层目录下的 SKILL.md。文件数 ≤ 256、单文件 ≤ 1 MiB、总量 ≤ 20 MiB。
            encoding:
              display_title:
                contentType: text/plain
      responses:
        '201':
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
