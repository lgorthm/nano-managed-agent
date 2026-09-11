# 更新 Agent

> 更新指定 Agent 并在配置变化时生成新的不可变版本。可带当前 `version`；不一致时返回 409，避免覆盖刚发生的改动。已归档 Agent 不可更新。MCP Server 与 `mcp_toolset` 必须按名称一一对应。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "version": 1,
    "system": "You are a helpful coding agent. Always write tests."
  }'
```

响应 `200`（`version` 递增为 2）：

```json
{
  "id": "agent_01911111-1111-7111-8111-111111111111",
  "type": "agent",
  "name": "Coding Assistant",
  "model": { "id": "glm-5.3", "effort": "max", "speed": "standard" },
  "system": "You are a helpful coding agent. Always write tests.",
  "description": null,
  "tools": [
    {
      "type": "agent_toolset_20260601",
      "default_config": {
        "enabled": true,
        "permission_policy": { "type": "always_allow" }
      },
      "configs": []
    }
  ],
  "skills": [],
  "mcp_servers": [],
  "metadata": {},
  "multiagent": null,
  "version": 2,
  "created_at": "2026-08-20T08:24:10.412Z",
  "updated_at": "2026-08-20T09:01:55.000Z",
  "archived_at": null
}
```

### 更新语义（与 GLM 一致）

- **省略的字段保持不变**，只需提交想改的字段。
- **标量字段**（`model`、`system`、`name`、`description`）整体替换为新值。`system` 和 `description` 可传 null 清空；`name` 和 `model` 不可清空。
- **数组字段**（`tools`、`mcp_servers`、`skills`）整体替换为新数组，传 null 或空数组可全部清空。`tools` 中包含 `mcp_toolset` 时，必须与 `mcp_servers` 在同一次请求中一起替换，保证引用一致。
- **metadata 按键级合并**：提交的键新增或覆盖，未提交的键保留，把某个键设为 null 可删除它。
- **version 可选**：带上当前版本号时，如果这期间别人已经改过这个 Agent，返回 409；省略则直接覆盖。交互式调用建议携带 `version`；声明式同步循环（如 CI）适合省略。
- **无变化检测**：合并后的结果与当前版本完全一致时不生成新版本，直接返回现有版本（`version` 不变）。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 校验失败（同创建）；或 Agent 已归档 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Agent 不存在 |
| 409 | `invalid_request_error` | 携带的 `version` 与当前版本不一致（期间已被其他调用者修改） |

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
  - name: Agent
    description: Agent 与版本管理。
paths:
  /v1/agents/{agentId}:
    post:
      tags: [Agent]
      summary: 更新 Agent
      description: >-
        更新指定 Agent 并在配置变化时生成新的不可变版本。可带当前 version；不一致时返回 409。已归档 Agent
        不可更新。MCP Server 与 mcp_toolset 必须按名称一一对应。
      operationId: updateAgent
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: agentId
          in: path
          required: true
          description: agentId 资源标识。
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AgentUpdateRequest'
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Agent'
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
    AgentUpdateRequest:
      type: object
      properties:
        version:
          type: number
          minimum: 1
          description: 可选。带上当前版本号时，若期间配置已被他人改过则返回 409；省略则按本次提交覆盖。须为正整数。
        name:
          type: string
          minLength: 1
          maxLength: 256
          description: 替换 Agent 名称；省略时保持不变。
        model:
          allOf:
            - $ref: '#/components/schemas/ModelInput'
          description: 替换完整模型配置；省略时保持不变。
        system:
          type: string
          nullable: true
          maxLength: 100000
          description: 替换系统提示词；null 表示清空，省略时保持不变。
        description:
          type: string
          nullable: true
          maxLength: 2048
          description: 替换用途说明；null 表示清空，省略时保持不变。
        tools:
          type: array
          nullable: true
          maxItems: 128
          description: 整体替换工具列表；null 或空数组表示清空，省略时保持不变。若包含 mcp_toolset，必须同时提交 mcp_servers。
          items:
            $ref: '#/components/schemas/AgentToolsetInput'
        skills:
          type: array
          nullable: true
          maxItems: 20
          uniqueItems: true
          description: 整体替换 Skill 列表；null 或空数组表示清空，省略时保持不变。有效配置必须包含 agent_toolset_20260601。
          items:
            $ref: '#/components/schemas/SkillReference'
        mcp_servers:
          type: array
          nullable: true
          maxItems: 20
          description: 整体替换 MCP Server 列表；仅能与 tools 同时提交，null 或空数组表示清空。最终配置必须与 mcp_toolset 按名称一一对应。
          items:
            $ref: '#/components/schemas/McpServer'
        metadata:
          $ref: '#/components/schemas/MetadataPatch'
      additionalProperties: false
    Agent:
      type: object
      properties:
        id:
          type: string
          description: Agent ID。
          example: agent_01911111-1111-7111-8111-111111111111
        type:
          type: string
          enum: [agent]
        name:
          type: string
        description:
          type: string
          nullable: true
          description: 用途说明。
        model:
          $ref: '#/components/schemas/ModelResponse'
        system:
          type: string
          nullable: true
          description: 系统提示词。
        tools:
          type: array
          items:
            $ref: '#/components/schemas/AgentToolsetResponse'
        skills:
          type: array
          items:
            $ref: '#/components/schemas/SkillReference'
        mcp_servers:
          type: array
          items:
            $ref: '#/components/schemas/McpServer'
        metadata:
          $ref: '#/components/schemas/Metadata'
        version:
          type: integer
          minimum: 0
        created_at:
          type: string
          format: date-time
          description: 创建时间（版本级）。
        updated_at:
          type: string
          format: date-time
          description: 更新时间（版本级）。
        multiagent:
          type: object
          nullable: true
          enum: [null]
          description: 当前暂未支持，默认为 null。
        archived_at:
          type: string
          nullable: true
          description: 归档时间；未归档时为 null。
      required:
        - id
        - type
        - name
        - model
        - system
        - description
        - tools
        - skills
        - mcp_servers
        - metadata
        - version
        - created_at
        - updated_at
        - archived_at
      additionalProperties: false
      example:
        id: agent_01911111-1111-7111-8111-111111111111
        type: agent
        name: support-agent
        description: null
        model:
          id: glm-5.3
          effort: max
          speed: standard
        system: null
        tools:
          - type: agent_toolset_20260601
        skills: []
        mcp_servers: []
        metadata: {}
        multiagent: null
        version: 1
        created_at: '2026-08-31T08:00:00.000Z'
        updated_at: '2026-08-31T08:00:00.000Z'
        archived_at: null
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
    ModelInput:
      title: Agent 模型
      example: glm-5.3
      default: glm-5.3
      oneOf:
        - title: 模型 ID
          type: string
          enum: [glm-5.3, glm-5.3-flash]
          example: glm-5.3
          default: glm-5.3
        - title: 模型配置
          type: object
          properties:
            id:
              type: string
              enum: [glm-5.3, glm-5.3-flash]
              example: glm-5.3
              default: glm-5.3
            effort:
              type: string
              nullable: true
              enum: [low, high, max]
              description: glm-5.3 省略或传 null 时使用 max；glm-5.3-flash 省略或传 null 时使用 high。
            speed:
              type: string
              nullable: true
              enum: [standard]
              default: standard
              description: 当前仅支持 standard；省略或传 null 时也使用 standard。
          required: [id]
          additionalProperties: false
      description: >-
        模型 ID，或包含推理强度与速度的模型配置。当前仅支持 glm-5.3 与 glm-5.3-flash。使用字符串简写时，服务端按模型补齐默认
        effort，并将 speed 补为 standard。
    AgentToolsetInput:
      oneOf:
        - title: agent_toolset_20260601
          type: object
          properties:
            type:
              type: string
              enum: [agent_toolset_20260601]
            default_config:
              allOf:
                - $ref: '#/components/schemas/ToolDefaultConfigInput'
              nullable: true
              default: null
              description: 工具集默认配置；省略或传 null 时 enabled=true、permission_policy=always_allow。
            configs:
              type: array
              maxItems: 128
              default: []
              description: 逐工具覆盖；省略时为空，name 不得重复。
              items:
                $ref: '#/components/schemas/BuiltinToolConfigInput'
          required: [type]
          additionalProperties: false
        - title: mcp_toolset
          type: object
          properties:
            type:
              type: string
              enum: [mcp_toolset]
            mcp_server_name:
              type: string
              minLength: 1
              description: 必须精确匹配 mcp_servers 中唯一一个 Server 的 name。
            default_config:
              allOf:
                - $ref: '#/components/schemas/ToolDefaultConfigInput'
              nullable: true
              default: null
              description: MCP 工具集默认配置；省略或传 null 时 enabled=true、permission_policy=always_allow。
            configs:
              type: array
              maxItems: 128
              default: []
              description: 逐 MCP 工具覆盖；省略时为空，name 不得重复。
              items:
                $ref: '#/components/schemas/McpToolConfigInput'
          required: [type, mcp_server_name]
          additionalProperties: false
        - title: custom
          type: object
          properties:
            type:
              type: string
              enum: [custom]
            name:
              type: string
              minLength: 1
              maxLength: 128
              pattern: ^[A-Za-z0-9_-]+$
              description: 自定义工具名；仅允许字母、数字、下划线和连字符，不得以 mcp__ 开头，且同一配置内不得重复。
            description:
              type: string
              minLength: 1
              maxLength: 4096
            input_schema:
              $ref: '#/components/schemas/CustomToolInputSchema'
          required: [type, name, description, input_schema]
          additionalProperties: false
    SkillReference:
      type: object
      properties:
        type:
          type: string
          enum: [custom, zai]
          description: custom 表示当前所有者创建的 Skill；zai 表示平台内置 Skill。
        skill_id:
          type: string
          minLength: 1
          description: Skill ID；必须存在且当前身份可访问。
        version:
          type: string
          minLength: 1
          description: 必须显式固定的 Skill 版本。
      required: [type, skill_id, version]
      additionalProperties: false
    McpServer:
      type: object
      description: 远程 MCP Server。name 在同一配置内必须唯一，并且必须与 tools 中恰好一个 mcp_toolset.mcp_server_name 相同。
      properties:
        type:
          type: string
          enum: [url]
          description: 当前只支持 url。
        name:
          type: string
          minLength: 1
          maxLength: 255
          description: Server 名称，长度 1–255；同一 mcp_servers 数组内不得重复。
        url:
          type: string
          format: uri
          pattern: ^https://
          maxLength: 2048
          description: 公开 HTTPS Streamable HTTP URL；不得包含凭据、fragment、空 query 或旧式 SSE 路径。
      required: [type, name, url]
      additionalProperties: false
      example:
        type: url
        name: knowledge-base
        url: https://mcp.example.com/mcp
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
    ModelResponse:
      type: object
      properties:
        id:
          type: string
          example: glm-5.3
        effort:
          type: string
          enum: [low, high, max]
          example: max
        speed:
          type: string
          enum: [standard]
          example: standard
      required: [id, speed]
      additionalProperties: false
    AgentToolsetResponse:
      oneOf:
        - title: agent_toolset_20260601
          type: object
          properties:
            type:
              type: string
              enum: [agent_toolset_20260601]
            default_config:
              $ref: '#/components/schemas/ToolDefaultConfigResponse'
            configs:
              type: array
              items:
                $ref: '#/components/schemas/BuiltinToolConfigResponse'
          required: [type, default_config, configs]
          additionalProperties: false
        - title: mcp_toolset
          type: object
          properties:
            type:
              type: string
              enum: [mcp_toolset]
            mcp_server_name:
              type: string
            default_config:
              $ref: '#/components/schemas/ToolDefaultConfigResponse'
            configs:
              type: array
              items:
                $ref: '#/components/schemas/McpToolConfigResponse'
          required: [type, mcp_server_name, default_config, configs]
          additionalProperties: false
        - title: custom
          type: object
          properties:
            type:
              type: string
              enum: [custom]
            name:
              type: string
            description:
              type: string
            input_schema:
              $ref: '#/components/schemas/CustomToolInputSchema'
          required: [type, name, description, input_schema]
          additionalProperties: false
    ToolDefaultConfigInput:
      type: object
      properties:
        enabled:
          type: boolean
          nullable: true
          default: true
          description: 工具集默认是否启用；省略或传 null 时为 true。
        permission_policy:
          allOf:
            - $ref: '#/components/schemas/PermissionPolicy'
          nullable: true
          default:
            type: always_allow
          description: 工具集默认权限策略；省略或传 null 时为 always_allow。
      additionalProperties: false
    BuiltinToolConfigInput:
      type: object
      properties:
        name:
          type: string
          enum: [read, write, edit, bash, grep, find, ls]
          description: 要覆盖的内置工具名；同一 configs 数组内不得重复。
        enabled:
          type: boolean
          nullable: true
          description: 覆盖当前工具的 enabled；省略或传 null 时继承 default_config。
        permission_policy:
          allOf:
            - $ref: '#/components/schemas/PermissionPolicy'
          nullable: true
          description: 覆盖当前工具的权限策略；省略或传 null 时继承 default_config。
      required: [name]
      additionalProperties: false
    McpToolConfigInput:
      type: object
      properties:
        name:
          type: string
          minLength: 1
          description: MCP Server 实际公开的工具名；同一 configs 数组内不得重复。
        enabled:
          type: boolean
          nullable: true
          description: 覆盖当前 MCP 工具的 enabled；省略或传 null 时继承 default_config。
        permission_policy:
          allOf:
            - $ref: '#/components/schemas/PermissionPolicy'
          nullable: true
          description: 覆盖当前 MCP 工具的权限策略；省略或传 null 时继承 default_config。
      required: [name]
      additionalProperties: false
    CustomToolInputSchema:
      type: object
      properties:
        type:
          type: string
          enum: [object]
          description: 固定为 object。
        properties:
          type: object
          additionalProperties: true
          description: 工具输入字段的 JSON Schema；省略时表示未声明属性。
        required:
          type: array
          items:
            type: string
          description: 必填输入字段名；省略时无必填字段。
      required: [type]
      additionalProperties: true
    ToolDefaultConfigResponse:
      type: object
      properties:
        enabled:
          type: boolean
        permission_policy:
          $ref: '#/components/schemas/PermissionPolicy'
      required: [enabled, permission_policy]
      additionalProperties: false
    BuiltinToolConfigResponse:
      type: object
      properties:
        name:
          type: string
          enum: [read, write, edit, bash, grep, find, ls]
        enabled:
          type: boolean
        permission_policy:
          $ref: '#/components/schemas/PermissionPolicy'
      required: [name, enabled, permission_policy]
      additionalProperties: false
    McpToolConfigResponse:
      type: object
      properties:
        name:
          type: string
        enabled:
          type: boolean
        permission_policy:
          $ref: '#/components/schemas/PermissionPolicy'
      required: [name, enabled, permission_policy]
      additionalProperties: false
    PermissionPolicy:
      type: object
      properties:
        type:
          type: string
          enum: [always_allow, always_ask]
          description: 工具调用权限策略。always_allow 表示无需确认；always_ask 表示每次调用前请求确认。
      required: [type]
      additionalProperties: false
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: 标准 HTTP Bearer 认证；API Key 配置在 Worker 环境变量 API_KEY 中。
````
