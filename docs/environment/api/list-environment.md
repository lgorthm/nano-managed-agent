# 列出 Environment

> 分页列出当前身份可读取的 Environment（含已归档）。支持通过 `limit`、`order` 和 `page` 游标翻页。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/environments?limit=20&order=desc" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "data": [
    {
      "id": "env_01911111-2222-7222-8222-222222222222",
      "type": "environment",
      "name": "data-analysis-env",
      "description": "数据分析沙箱：预装绘图与表格依赖",
      "metadata": {},
      "config": {
        "type": "cloud",
        "packages": {
          "type": "packages",
          "apt": ["poppler-utils"],
          "cargo": [],
          "gem": [],
          "go": [],
          "npm": ["typescript"],
          "pip": ["pandas", "matplotlib", "openpyxl"]
        },
        "networking": { "type": "unrestricted" }
      },
      "scope": "organization",
      "state": "active",
      "archived_at": null,
      "created_at": "2026-09-11T08:00:00.000Z",
      "updated_at": "2026-09-11T08:00:00.000Z"
    }
  ],
  "next_page": null
}
```

分页说明见 [README.md](README.md#分页)。nano 实现按 `(created_at, id)` keyset 排序（默认 `desc`，即最新创建的在前）；游标对客户端 opaque。GLM 的列表仅支持 `limit` / `page`，`order` 参数是 nano 对统一分页约定的补充（见 [README.md](README.md#与-glm-managed-agents-的差异)）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | `limit` 小于 1、`order` 非法或 `page` 游标无效 |
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
  - name: Environment
    description: 声明式执行环境管理。
paths:
  /v1/environments:
    get:
      tags: [Environment]
      summary: 列出 Environment
      description: 分页列出当前身份可读取的 Environment（含已归档）。支持通过 limit、order 和 page 游标翻页。
      operationId: listEnvironments
      parameters:
        - $ref: '#/components/parameters/Authorization'
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
          description: 排序方向。
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
                $ref: '#/components/schemas/EnvironmentPage'
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
    EnvironmentPage:
      type: object
      properties:
        data:
          type: array
          items:
            $ref: '#/components/schemas/Environment'
        next_page:
          type: string
          nullable: true
      required: [data, next_page]
      additionalProperties: false
    Environment:
      type: object
      properties:
        id:
          type: string
          description: Environment ID。
          example: env_01911111-2222-7222-8222-222222222222
        type:
          type: string
          enum: [environment]
        name:
          type: string
        description:
          type: string
          nullable: true
          description: 用途说明。
        metadata:
          $ref: '#/components/schemas/Metadata'
        config:
          $ref: '#/components/schemas/EnvironmentConfigResponse'
        scope:
          type: string
          enum: [organization]
        state:
          type: string
          enum: [active, archived]
        archived_at:
          type: string
          nullable: true
          description: 归档时间；未归档时为 null。
        created_at:
          type: string
          format: date-time
          description: 创建时间。
        updated_at:
          type: string
          format: date-time
          description: 更新时间。
      required:
        - id
        - type
        - name
        - description
        - metadata
        - config
        - scope
        - state
        - archived_at
        - created_at
        - updated_at
      additionalProperties: false
      example:
        id: env_01911111-2222-7222-8222-222222222222
        type: environment
        name: data-analysis-env
        description: 数据分析沙箱：预装绘图与表格依赖
        metadata: {}
        config:
          type: cloud
          packages:
            type: packages
            apt: [poppler-utils]
            cargo: []
            gem: []
            go: []
            npm: [typescript]
            pip: [pandas, matplotlib, openpyxl]
          networking:
            type: unrestricted
        scope: organization
        state: active
        archived_at: null
        created_at: '2026-09-11T08:00:00.000Z'
        updated_at: '2026-09-11T08:00:00.000Z'
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
    Metadata:
      type: object
      additionalProperties:
        type: string
      description: 客户端自定义元数据；省略时默认为空对象。最多 16 个键，键名长度不超过 64 字符，值必须是长度不超过 512 字符的字符串。
      maxProperties: 16
    EnvironmentConfigResponse:
      type: object
      description: 归一化后的完整配置；六个包管理器键全部出现，networking 为具体生效策略。
      properties:
        type:
          type: string
          enum: [cloud]
        packages:
          $ref: '#/components/schemas/EnvironmentPackagesResponse'
        networking:
          $ref: '#/components/schemas/EnvironmentNetworkingResponse'
      required:
        - type
        - packages
        - networking
      additionalProperties: false
    EnvironmentPackagesResponse:
      type: object
      properties:
        type:
          type: string
          enum: [packages]
        apt:
          type: array
          items:
            type: string
        cargo:
          type: array
          items:
            type: string
        gem:
          type: array
          items:
            type: string
        go:
          type: array
          items:
            type: string
        npm:
          type: array
          items:
            type: string
        pip:
          type: array
          items:
            type: string
      required:
        - type
        - apt
        - cargo
        - gem
        - go
        - npm
        - pip
      additionalProperties: false
    EnvironmentNetworkingResponse:
      oneOf:
        - title: unrestricted
          type: object
          properties:
            type:
              type: string
              enum: [unrestricted]
          required:
            - type
          additionalProperties: false
        - title: limited
          type: object
          properties:
            type:
              type: string
              enum: [limited]
            allowed_hosts:
              type: array
              items:
                type: string
            allow_package_managers:
              type: boolean
            allow_mcp_servers:
              type: boolean
          required:
            - type
            - allowed_hosts
            - allow_package_managers
            - allow_mcp_servers
          additionalProperties: false
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: 标准 HTTP Bearer 认证；API Key 配置在 Worker 环境变量 API_KEY 中。
````
