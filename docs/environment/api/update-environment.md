# 更新 Environment

> 更新指定 Environment 的名称、说明、元数据或云端配置。未提供的字段保持不变。更新只影响之后创建的会话——正在运行的会话持有创建时固化的环境快照。已归档的 Environment 不能更新。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/environments/$ENVIRONMENT_ID" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "description": "受限出网：仅放行内部 API 与 PyPI 镜像",
    "config": {
      "type": "cloud",
      "packages": { "pip": ["requests"] },
      "networking": {
        "type": "limited",
        "allowed_hosts": ["api.example.com", "*.internal.example.com"],
        "allow_package_managers": true
      }
    }
  }'
```

响应 `200`（`config` 被整体替换，`allowed_hosts` 规范化回显）：

```json
{
  "id": "env_01911111-2222-7222-8222-222222222222",
  "type": "environment",
  "name": "data-analysis-env",
  "description": "受限出网：仅放行内部 API 与 PyPI 镜像",
  "metadata": {},
  "config": {
    "type": "cloud",
    "packages": {
      "type": "packages",
      "apt": [],
      "cargo": [],
      "gem": [],
      "go": [],
      "npm": [],
      "pip": ["requests"]
    },
    "networking": {
      "type": "limited",
      "allowed_hosts": ["api.example.com", "*.internal.example.com"],
      "allow_package_managers": true,
      "allow_mcp_servers": false
    }
  },
  "scope": "organization",
  "state": "active",
  "archived_at": null,
  "created_at": "2026-09-11T08:00:00.000Z",
  "updated_at": "2026-09-11T09:01:55.000Z"
}
```

上例中此前声明的 `apt` / `npm` 包随 config 整体替换一并消失；`allowed_hosts` 服务端小写化、排序、去重后回显，`allow_mcp_servers` 省略补为 false。

### 更新语义（与 GLM 一致）

- **省略的字段保持不变**，只需提交想改的字段。
- **`name` / `description` 标量整体替换**。`description` 可传 null 清空；`name` 不可清空。
- **`config` 整体替换（非深合并）**：提交的 config 完全取代现有配置，未提及的包管理器列表清空为空数组。传 null 恢复默认 cloud 配置（空 packages + unrestricted 网络），省略时保持不变。
- **metadata 按键级合并**：提交的键新增或覆盖，未提交的键保留，把某个键设为 null 可删除它。
- **`scope` 只接受 `organization`**，传 null 或省略不会改变现有作用域。
- **无 `version` 字段、无 409**：Environment 没有版本概念，更新是最后写入获胜，不存在乐观并发冲突。
- **无变化检测**：合并后的结果与当前落库形态完全一致时不写库，`updated_at` 不变，直接返回现状。
- **联动校验作用于合并后的完整配置**：替换进来的 config 声明了 packages 且 networking 为 `limited` 时，必须显式 `allow_package_managers: true`，否则返回 400。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 校验失败（同创建：config / packages / networking 非法、limited 声明 packages 但未放行包管理器联网、metadata 超限等）；或 Environment 已归档 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Environment 不存在 |

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
    post:
      tags: [Environment]
      summary: 更新 Environment
      description: >-
        更新指定 Environment 的名称、说明、元数据或云端配置。未提供的字段保持不变；更新只影响之后创建的会话。已归档的
        Environment 不能更新。
      operationId: updateEnvironment
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: environmentId
          in: path
          required: true
          description: environmentId 资源标识。
          schema:
            type: string
      requestBody:
        required: false
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/EnvironmentUpdateRequest'
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
    EnvironmentUpdateRequest:
      type: object
      properties:
        name:
          type: string
          minLength: 1
          maxLength: 256
          description: 替换名称；省略时保持不变。
        description:
          type: string
          nullable: true
          maxLength: 1024
          description: 替换用途说明；null 表示清空，省略时保持不变。
        metadata:
          $ref: '#/components/schemas/MetadataPatch'
        scope:
          type: string
          nullable: true
          enum: [organization]
          description: 只能为 organization；null 或省略不会改变现有作用域。
        config:
          allOf:
            - $ref: '#/components/schemas/EnvironmentConfigInput'
          nullable: true
          description: 替换完整配置；null 表示恢复默认 cloud 配置，省略时保持不变。
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
        description: 受限出网：仅放行内部 API 与 PyPI 镜像
        metadata: {}
        config:
          type: cloud
          packages:
            type: packages
            apt: []
            cargo: []
            gem: []
            go: []
            npm: []
            pip: [requests]
          networking:
            type: limited
            allowed_hosts: [api.example.com, '*.internal.example.com']
            allow_package_managers: true
            allow_mcp_servers: false
        scope: organization
        state: active
        archived_at: null
        created_at: '2026-09-11T08:00:00.000Z'
        updated_at: '2026-09-11T09:01:55.000Z'
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
    MetadataPatch:
      type: object
      properties: {}
      nullable: true
      maxProperties: 16
      additionalProperties:
        type: string
        nullable: true
      description: 元数据补丁；省略整个字段时保持不变，键值为 null 时删除对应键。最多 16 个键，键名长度不超过 64 字符，字符串值不超过 512 字符。
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
