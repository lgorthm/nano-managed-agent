# 获取 Agent

> 获取指定 Agent 的当前版本及完整配置，包括模型、系统提示词、工具、Skill、MCP Server、元数据和归档时间。无读取权限时与资源不存在时均返回 404。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/agents/$AGENT_ID" \
  -H "Authorization: Bearer $NANO_API_KEY"
```

响应 `200`：

```json
{
  "id": "agent_01911111-1111-7111-8111-111111111111",
  "type": "agent",
  "name": "support-agent",
  "description": null,
  "model": { "id": "glm-5.3", "effort": "max", "speed": "standard" },
  "system": null,
  "tools": [{ "type": "agent_toolset_20260601" }],
  "skills": [],
  "mcp_servers": [],
  "metadata": {},
  "multiagent": null,
  "version": 1,
  "created_at": "2026-08-31T08:00:00.000Z",
  "updated_at": "2026-08-31T08:00:00.000Z",
  "archived_at": null
}
```

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Agent 不存在（无权限与不存在同返回 404） |

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
    get:
      tags: [Agent]
      summary: 获取 Agent
      description: 获取指定 Agent 的当前版本及完整配置，包括模型、系统提示词、工具、Skill、MCP Server、元数据和归档时间。
      operationId: getAgent
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: agentId
          in: path
          required: true
          description: agentId 资源标识。
          schema:
            type: string
      responses:
        '200':
          description: 请求成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Agent'
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
    Metadata:
      type: object
      additionalProperties:
        type: string
      description: 客户端自定义元数据；省略时默认为空对象。最多 16 个键，键名长度不超过 64 字符，值必须是长度不超过 512 字符的字符串。
      maxProperties: 16
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
