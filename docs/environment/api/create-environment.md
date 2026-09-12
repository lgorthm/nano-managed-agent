# 创建 Environment

> 创建 Environment：声明沙箱中预装的软件包与出网策略，供将来的会话与定时部署引用。最简形态只需一个 `name`，配置省略时使用默认值（cloud 类型、无额外软件包、无限制网络）。省略与默认的字段在响应中以归一化后的完整形态回显。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/environments" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "data-analysis-env",
    "description": "数据分析沙箱：预装绘图与表格依赖",
    "config": {
      "type": "cloud",
      "packages": {
        "apt": ["poppler-utils"],
        "pip": ["pandas", "matplotlib", "openpyxl"],
        "npm": ["typescript"]
      },
      "networking": {"type": "unrestricted"}
    }
  }'
```

响应 `201`：

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

响应中的 `config` 是归一化后的完整配置：`packages` 六个包管理器的列表都会出现（未声明为空数组），`networking` 回显生效的网络策略。`config` 省略或传 null 时等价于 `{type: "cloud"}`——空 packages 加 unrestricted 网络；`packages` 内六类列表省略或 null 时规范化为空数组，重复项去重；`networking` 为 `limited` 时 `allowed_hosts` 服务端小写化、排序、去重，`allow_package_managers` 与 `allow_mcp_servers` 省略或 null 时补为 false。

云沙箱镜像预装了常用的语言运行时与工具链（Python、Node.js、常见 CLI 工具等），`packages` 声明用于在这个基线之上增装依赖；服务端按 apt → cargo → gem → go → npm → pip 的顺序安装。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 校验失败：`name` 缺失或长度不在 1–256、`description` 超 1024、metadata 超限、`config.type` 非 `cloud`（`self_hosted` 被拒绝）、config / packages / networking 内出现未知字段、包名含空白或控制字符 / 以 `-` 开头 / 超 256 字符、`allowed_hosts` 带协议 / 端口 / 路径或超限、limited 声明 packages 但 `allow_package_managers` 未显式 true 等 |
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
    post:
      tags: [Environment]
      summary: 创建 Environment
      description: >-
        创建 Environment：声明沙箱中预装的软件包与出网策略。可配置预装软件包和网络策略；省略配置时使用平台默认设置（cloud、空
        packages、unrestricted networking）。
      operationId: createEnvironment
      parameters:
        - $ref: '#/components/parameters/Authorization'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/EnvironmentCreateRequest'
            example:
              name: data-analysis-env
              description: 数据分析沙箱：预装绘图与表格依赖
              config:
                type: cloud
                packages:
                  apt: [poppler-utils]
                  pip: [pandas, matplotlib, openpyxl]
                  npm: [typescript]
                networking:
                  type: unrestricted
      responses:
        '201':
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
    EnvironmentCreateRequest:
      type: object
      description: 创建 Environment。config 内出现未支持的字段时请求会被拒绝。
      properties:
        name:
          type: string
          minLength: 1
          maxLength: 256
          description: Environment 名称，长度 1–256 个字符。
        description:
          type: string
          nullable: true
          maxLength: 1024
          default: null
          description: 用途说明；省略或传 null 时不设置。
        metadata:
          $ref: '#/components/schemas/Metadata'
        scope:
          type: string
          nullable: true
          enum: [organization]
          default: organization
          description: 一期仅支持 organization；省略或传 null 时也使用 organization。
        config:
          allOf:
            - $ref: '#/components/schemas/EnvironmentConfigInput'
          nullable: true
          default: null
          description: 运行环境配置；省略或传 null 时使用 cloud、空 packages、unrestricted networking。
      required:
        - name
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
    EnvironmentConfigInput:
      type: object
      properties:
        type:
          type: string
          enum: [cloud]
          description: 当前只支持 cloud；self_hosted 会被拒绝。
        packages:
          allOf:
            - $ref: '#/components/schemas/EnvironmentPackagesInput'
          nullable: true
          default: null
          description: 包声明；省略或传 null 时六类包列表均为空。
        networking:
          allOf:
            - $ref: '#/components/schemas/EnvironmentNetworkingInput'
          nullable: true
          default: null
          description: 网络策略；省略或传 null 时为 unrestricted。
      required:
        - type
      additionalProperties: false
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
    EnvironmentPackagesInput:
      type: object
      description: 声明需要预装的包；六类包管理器均可省略，省略或 null 会规范化为空数组。自定义 registry / source / index URL 与私有源凭据配置一律拒绝。
      properties:
        type:
          type: string
          enum: [packages]
          description: 可选判别字段；提供时只能为 packages。
        apt:
          type: array
          nullable: true
          maxItems: 200
          default: []
          description: 最多 200 个不同包名；null/省略视为空数组，重复项会去重。每项 trim 后不能为空、不能包含空白或控制字符，也不能以 - 开头。
          items:
            type: string
            minLength: 1
            maxLength: 256
        cargo:
          type: array
          nullable: true
          maxItems: 200
          default: []
          description: 最多 200 个不同包名；null/省略视为空数组，重复项会去重。每项 trim 后不能为空、不能包含空白或控制字符，也不能以 - 开头。
          items:
            type: string
            minLength: 1
            maxLength: 256
        gem:
          type: array
          nullable: true
          maxItems: 200
          default: []
          description: 最多 200 个不同包名；null/省略视为空数组，重复项会去重。每项 trim 后不能为空、不能包含空白或控制字符，也不能以 - 开头。
          items:
            type: string
            minLength: 1
            maxLength: 256
        go:
          type: array
          nullable: true
          maxItems: 200
          default: []
          description: 最多 200 个不同包名；null/省略视为空数组，重复项会去重。每项 trim 后不能为空、不能包含空白或控制字符，也不能以 - 开头。
          items:
            type: string
            minLength: 1
            maxLength: 256
        npm:
          type: array
          nullable: true
          maxItems: 200
          default: []
          description: 最多 200 个不同包名；null/省略视为空数组，重复项会去重。每项 trim 后不能为空、不能包含空白或控制字符，也不能以 - 开头。
          items:
            type: string
            minLength: 1
            maxLength: 256
        pip:
          type: array
          nullable: true
          maxItems: 200
          default: []
          description: 最多 200 个不同包名；null/省略视为空数组，重复项会去重。每项 trim 后不能为空、不能包含空白或控制字符，也不能以 - 开头。
          items:
            type: string
            minLength: 1
            maxLength: 256
      additionalProperties: false
    EnvironmentNetworkingInput:
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
              nullable: true
              maxItems: 256
              default: []
              description: 最多 256 个不同 host；null/省略视为空数组，重复项会去重。只接受 hostname 或 *.example.com 通配形式，不得包含协议、端口或路径。
              items:
                type: string
                maxLength: 255
            allow_package_managers:
              type: boolean
              nullable: true
              default: false
              description: 是否允许包管理器联网；省略或传 null 时为 false。limited 模式声明 packages 时必须显式设为 true。
            allow_mcp_servers:
              type: boolean
              nullable: true
              default: false
              description: 是否允许已配置的 MCP Server 联网；省略或传 null 时为 false。
          required:
            - type
          additionalProperties: false
      description: 网络策略。省略整个 networking 时默认为 unrestricted。
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
