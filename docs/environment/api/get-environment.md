# 获取 Environment

> 获取指定 Environment 的名称、配置、元数据、状态及归档信息。无读取权限时与资源不存在时均返回 404。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/environments/$ENVIRONMENT_ID" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
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
```

已归档的 Environment 同样可以读取（`state` 为 `archived`、`archived_at` 已填充）；归档只阻止更新与新的会话 / 部署绑定，不阻止读取。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Environment 不存在（无权限与不存在同返回 404） |

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
  /v1/environments/{environmentId}:
    get:
      tags: [Environment]
      summary: 获取 Environment
      description: 获取指定 Environment 的名称、配置、元数据、状态及归档信息。无读取权限时与资源不存在时均返回 404。
      operationId: getEnvironment
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: environmentId
          in: path
          required: true
          description: environmentId 资源标识。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Environment'
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
