# 删除 Skill Version

> 删除指定 Skill Version 及其文件内容。被 Agent 配置引用的版本不能删除；如果删除的是最新版本，Skill 会自动指向剩余版本中最新的一版，没有剩余版本时 `latest_version` 为空。删除成功返回 `{id, type}` 回执。

## 请求示例

```bash
curl -sS -X DELETE "http://127.0.0.1:8787/v1/skills/skill_01911111-2222-7333-8444-555555555555/versions/1" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "skv_01911111-2222-7111-8222-444444444444",
  "type": "skill_version_deleted"
}
```

两条行为规则：

- **引用保护**：被**活动配置**（未归档 Agent 的当前版本快照）以 `(skill_id, version)` 引用时返回 400；更新 Agent 解除引用或归档 Agent 后可删。历史版本快照中的引用不阻止删除（见 [README.md](README.md#删除保护)）。
- **指针重指**：删除的是最新版本时，`latest_version` 自动落到剩余版本中最大的一版（同一个事务内完成）；没有剩余版本时置为 null，Skill 成为空壳，仍可获取、可继续上传新版本。被删版本的版本号不复用，后续上传从分配器当前值继续递增。

`version` 路径参数的合法形态同 [get-skill-version.md](get-skill-version.md)；`"01"`、`"1a"` 返回 400，合法但不存在（含已删除后重复删除）返回 404。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 被活动配置（未归档 Agent 的当前版本快照）引用；或 `version` 路径参数不是合法的版本号形态 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | `skillId` 不存在，或该版本不存在（含已删除后重复删除） |

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
    delete:
      tags: [Skill]
      summary: 删除 Skill Version
      description: >-
        删除指定 Skill Version 及其文件内容。被 Agent 版本快照引用的版本不能删除；删除最新版本时 Skill 自动指向剩余版本中最新的一版，没有剩余版本时
        latest_version 为 null。版本号删除后不复用。
      operationId: deleteSkillVersion
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
            example: '1'
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SkillVersionDeleted'
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
    SkillVersionDeleted:
      type: object
      properties:
        id:
          type: string
          description: 被删除的 SkillVersion ID（skv_ 前缀）。
        type:
          type: string
          enum: [skill_version_deleted]
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
