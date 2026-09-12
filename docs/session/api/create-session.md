# 创建 Session

> 基于指定 Agent 和 Environment 创建 Session。可钉住 Agent 版本或提供会话级覆盖，并可挂载 File 资源。创建即固化：Agent 配置（钉住版本 ⊕ 覆盖）与环境配置快照写入会话，此后对 Agent / Environment 的变更不影响本会话。响应回显解析后的完整配置快照，`status` 初始为 `idle`。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "agent": "agent_01911111-1111-7111-8111-111111111111",
    "environment_id": "env_01911111-2222-7222-8222-222222222222",
    "title": "Data analysis session",
    "resources": [
      {"type": "file", "file_id": "file_01911111-5555-7555-8555-555555555555"}
    ]
  }'
```

响应 `201`：

```json
{
  "id": "sess_01911111-3333-7333-8333-333333333333",
  "type": "session",
  "agent": {
    "id": "agent_01911111-1111-7111-8111-111111111111",
    "type": "agent",
    "name": "Coding Assistant",
    "model": { "id": "glm-5.3", "effort": "max", "speed": "standard" },
    "system": "You are a helpful coding agent.",
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
    "multiagent": null,
    "version": 3
  },
  "environment_id": "env_01911111-2222-7222-8222-222222222222",
  "status": "idle",
  "title": "Data analysis session",
  "metadata": {},
  "resources": [
    {
      "id": "sres_01911111-4444-7444-8444-444444444444",
      "type": "file",
      "file_id": "file_01911111-5555-7555-8555-555555555555",
      "mount_path": "/mnt/session/uploads/file_01911111-5555-7555-8555-555555555555",
      "created_at": "2026-09-12T08:00:00.000Z",
      "updated_at": "2026-09-12T08:00:00.000Z"
    }
  ],
  "vault_ids": [],
  "outcome_evaluations": [],
  "stats": { "active_seconds": 0, "duration_seconds": 0 },
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read_input_tokens": 0
  },
  "budget": null,
  "created_at": "2026-09-12T08:00:00.000Z",
  "updated_at": "2026-09-12T08:00:00.000Z",
  "archived_at": null
}
```

## 请求字段

| 字段 | 说明 |
| --- | --- |
| **agent** | 必填（缺 `agent` 时接受兼容字段 `agent_id`）。ID 字符串（钉当前版本）、`{type: "agent", id, version?}` 钉指定版本，或 `agent_with_overrides` 提供会话级覆盖，见下文。 |
| **environment_id** | 必填。Environment ID（`env_` 前缀），必须存在且未归档；创建时其配置被固化为会话快照。不存在返回 404，已归档返回 400。 |
| **title** | 可选。标题，最大 256 字符；null 不设置。 |
| **metadata** | 可选。最多 16 个 string 键值（key ≤ 64、value ≤ 512 字符）。 |
| **initial_events** | 可选。最多 50 条初始 `user.message` 事件。**nano 一期无事件存储，非空数组返回 400**；省略或空数组等价。 |
| **resources** | 可选。挂载资源，合计 ≤ 508 项。**一期仅支持 `type: "file"`（≤ 500）**，`memory_store` 返回 400；`mount_path` 归一化规则与重叠约束见 [add-session-file-resource.md](add-session-file-resource.md)。 |
| **vault_ids** | 可选。最多 20 个不重复的 Vault ID。**nano 无 Vault 资源，非空数组返回 400**；响应恒回显 `[]`。 |

## 为会话覆盖 Agent 配置

`agent` 的对象形态可以钉住特定版本，或在不改动 Agent 的前提下为单个会话覆盖配置：

```json
{ "agent": { "type": "agent", "id": "agent_01911111-1111-7111-8111-111111111111", "version": 3 } }
```

```json
{
  "agent": {
    "type": "agent_with_overrides",
    "id": "agent_01911111-1111-7111-8111-111111111111",
    "system": "You are a code reviewer. Only review, never modify files.",
    "tools": [
      {
        "type": "agent_toolset_20260601",
        "default_config": { "enabled": false },
        "configs": [
          { "name": "read", "enabled": true },
          { "name": "grep", "enabled": true }
        ]
      }
    ]
  }
}
```

覆盖语义：

- 可覆盖 **model**、**system**、**tools**、**skills**、**mcp_servers**；每个字段**整体替换**（非深合并），省略继承版本、null 与空数组清空。
- 覆盖只作用于本会话，Agent 本身不变；会话创建后覆盖即冻结（`tools` / `mcp_servers` 例外，可经更新端点整体替换）。
- 跨字段约束（`mcp_toolset` ↔ `mcp_servers` 一一对应、`skills` 非空须含 `agent_toolset_20260601`、skills 引用存在性）在**解析后的最终配置**上校验。
- 钉不存在的 `version` 返回 400，message 提示当前最新版本。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 校验失败：`agent` 与 `agent_id` 均缺失、`version` 不存在（附最新版本）、`environment_id` 已归档、`resources[].file_id` 不存在、`mount_path` 逃逸 / 重叠 / 超长、`file` 超 500、`memory_store` 类型、`initial_events` / `vault_ids` 非空、metadata 超限、覆盖后最终配置违反 mcp / skills 联动等 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | `agent`（或 `agent_id`）或 `environment_id` 引用的资源不存在 |

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
  - name: Session
    description: Session 与资源挂载。
paths:
  /v1/sessions:
    post:
      tags: [Session]
      summary: 创建 Session
      description: >-
        基于指定 Agent 和 Environment 创建 Session。可钉住 Agent 版本或提供会话级覆盖，并可挂载 File
        资源。创建即固化 Agent 解析快照与环境配置快照；status 初始为 idle。initial_events 与 vault_ids 非空、
        memory_store 资源类型在 nano 一期返回 400（见各字段说明）。
      operationId: createSession
      parameters:
        - $ref: '#/components/parameters/Authorization'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/SessionCreateRequest'
            example:
              agent: agent_01911111-1111-7111-8111-111111111111
              environment_id: env_01911111-2222-7222-8222-222222222222
              title: Data analysis session
      responses:
        '201':
          description: 创建成功。
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Session'
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
    SessionCreateRequest:
      type: object
      properties:
        agent:
          $ref: '#/components/schemas/SessionAgentInput'
        agent_id:
          type: string
          minLength: 1
          description: 兼容字段；agent 缺失时使用。
        environment_id:
          type: string
          minLength: 1
          maxLength: 64
          description: 必填的 Environment ID；必须存在且未归档。
          example: env_01911111-2222-7222-8222-222222222222
        title:
          type: string
          nullable: true
          maxLength: 256
          default: null
          description: 会话标题；省略或传 null 时不设置。
        metadata:
          $ref: '#/components/schemas/Metadata'
        initial_events:
          type: array
          maxItems: 50
          default: []
          description: >-
            创建后立即写入的 user.message 事件；省略时为空。nano 一期无事件存储，非空数组返回 400，待二期事件端点引入后放开。
          items:
            $ref: '#/components/schemas/InitialUserMessageEventInput'
        resources:
          type: array
          maxItems: 508
          default: []
          description: >-
            挂载资源；省略时为空。合计 ≤ 508 项；nano 一期仅支持 file（≤ 500），memory_store 返回 400。文件
            mount_path 不得重叠。
          items:
            $ref: '#/components/schemas/SessionResourceInput'
        vault_ids:
          type: array
          items:
            type: string
          maxItems: 20
          uniqueItems: true
          default: []
          description: 挂载的 Vault ID；nano 无 Vault 资源，非空返回 400，响应恒回显空数组。
      required:
        - environment_id
      description: 必须提供 agent 与 environment_id。未传 agent 时，服务端接受兼容字段 agent_id。
      anyOf:
        - title: agent
          required:
            - agent
        - title: agent_id
          required:
            - agent_id
      additionalProperties: false
    Session:
      type: object
      properties:
        id:
          type: string
          description: Session ID。
          example: sess_01911111-3333-7333-8333-333333333333
        type:
          type: string
          enum: [session]
        agent:
          $ref: '#/components/schemas/SessionAgentResponse'
        environment_id:
          type: string
          description: 引用的 Environment ID；配置已固化为会话快照。
        status:
          type: string
          enum: [idle, running, rescheduling, terminated]
          description: nano 一期恒为 idle；其余枚举值由二期运行时驱动。
        title:
          type: string
          nullable: true
          description: Session 标题。
        metadata:
          $ref: '#/components/schemas/Metadata'
        resources:
          type: array
          description: 挂载的 File 资源（含实际 mount_path）。
          items:
            $ref: '#/components/schemas/FileResourceResponse'
        vault_ids:
          type: array
          items:
            type: string
          description: nano 一期恒为空数组。
        outcome_evaluations:
          type: array
          items:
            type: object
            additionalProperties: true
          description: 结果评估；nano 一期恒为空数组。
        stats:
          type: object
          properties:
            active_seconds:
              type: number
            duration_seconds:
              type: number
          required: [active_seconds, duration_seconds]
          description: 运行统计；nano 一期恒为 0。
        usage:
          type: object
          properties:
            input_tokens:
              type: integer
            output_tokens:
              type: integer
            cache_read_input_tokens:
              type: integer
          required: [input_tokens, output_tokens, cache_read_input_tokens]
          description: 累计 token 用量；nano 一期恒为 0，二期由运行时累计。
        budget:
          type: object
          nullable: true
          enum: [null]
          description: 不支持会话级消费上限，固定为 null。
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
        archived_at:
          type: string
          nullable: true
          description: 归档时间；未归档时为 null。
      required:
        - id
        - type
        - agent
        - environment_id
        - status
        - title
        - metadata
        - resources
        - outcome_evaluations
        - stats
        - usage
        - vault_ids
        - created_at
        - updated_at
        - archived_at
      additionalProperties: false
    SessionAgentInput:
      oneOf:
        - title: Agent ID
          type: string
          minLength: 1
          description: Agent ID 字符串；钉创建请求时的当前版本。
        - title: agent
          $ref: '#/components/schemas/AgentReferenceInput'
        - title: agent_with_overrides
          $ref: '#/components/schemas/AgentWithOverridesInput'
      description: 可传 Agent ID 字符串、固定版本引用，或带会话级覆盖的 Agent 引用。
    AgentReferenceInput:
      type: object
      properties:
        type:
          type: string
          enum: [agent]
        id:
          type: string
          minLength: 1
          description: Agent ID。
        version:
          type: integer
          minimum: 1
          description: 固定使用的 Agent 版本；省略时固定创建请求时的当前版本。不存在时返回 400 并提示最新版本。
      required: [type, id]
      additionalProperties: false
    AgentWithOverridesInput:
      type: object
      properties:
        type:
          type: string
          enum: [agent_with_overrides]
        id:
          type: string
          minLength: 1
          description: Agent ID。
        version:
          type: integer
          minimum: 1
          description: 基准 Agent 版本；省略时固定创建请求时的当前版本。
        model:
          allOf:
            - $ref: '#/components/schemas/ModelInput'
          description: 覆盖完整模型配置；省略时继承 Agent 版本。
        system:
          type: string
          nullable: true
          maxLength: 100000
          description: 覆盖系统提示词；null 表示清空，省略时继承 Agent 版本。
        tools:
          type: array
          nullable: true
          maxItems: 128
          description: >-
            整体覆盖工具列表；null 或空数组表示清空，省略时继承 Agent 版本。MCP 映射约束在合并后的最终配置上校验。
          items:
            $ref: '#/components/schemas/AgentToolsetInput'
        skills:
          type: array
          nullable: true
          maxItems: 20
          uniqueItems: true
          description: 整体覆盖 Skill 列表；null 或空数组表示清空，省略时继承。最终配置含 Skill 时必须含 agent_toolset_20260601。
          items:
            $ref: '#/components/schemas/SkillReference'
        mcp_servers:
          type: array
          nullable: true
          maxItems: 20
          description: 整体覆盖 MCP Server；null 或空数组表示清空，省略时继承。最终配置必须与 mcp_toolset 一一对应。
          items:
            $ref: '#/components/schemas/McpServer'
      required: [type, id]
      additionalProperties: false
    SessionAgentResponse:
      type: object
      description: 创建时解析并固化的 Agent 配置快照（钉住版本 ⊕ 会话级覆盖）。
      properties:
        id:
          type: string
        type:
          type: string
          enum: [agent]
        name:
          type: string
        model:
          $ref: '#/components/schemas/ModelResponse'
        system:
          type: string
          nullable: true
          description: 解析后的系统提示词。
        description:
          type: string
          nullable: true
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
        multiagent:
          type: object
          nullable: true
          enum: [null]
          description: 当前暂未支持，默认为 null。
        version:
          type: integer
          minimum: 0
          description: 钉住的 Agent 版本号。
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
        - version
      additionalProperties: false
    SessionResourceInput:
      oneOf:
        - title: file
          allOf:
            - $ref: '#/components/schemas/FileResourceInput'
      description: nano 一期仅支持 file 类型。
    FileResourceInput:
      type: object
      properties:
        type:
          type: string
          enum: [file]
          description: 固定为 file。
        file_id:
          type: string
          minLength: 1
          description: 已存在的 File ID；不存在返回 400。
        mount_path:
          type: string
          nullable: true
          description: >-
            沙箱内挂载路径；省略或传 null 时默认为 /mnt/session/uploads/{file_id}。路径会归一化到
            /mnt/session/uploads 下，不能逃逸该目录，UTF-8 总长度不超过 1024 字节，且不得与现有挂载重叠。
      required: [type, file_id]
      additionalProperties: false
    FileResourceResponse:
      type: object
      properties:
        id:
          type: string
          description: 挂载资源 ID（sres_ 前缀）。
          example: sres_01911111-4444-7444-8444-444444444444
        type:
          type: string
          enum: [file]
        file_id:
          type: string
        mount_path:
          type: string
          description: 归一化后的挂载路径。
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
      required: [id, type, file_id, mount_path, created_at, updated_at]
      additionalProperties: false
    InitialUserMessageEventInput:
      type: object
      description: nano 一期不落地事件历史，该字段非空返回 400；schema 形状与 GLM 保持一致。
      properties:
        type:
          type: string
          enum: [user.message]
          description: 固定为 user.message。
        content:
          type: array
          minItems: 1
          maxItems: 20
          description: 初始消息内容，1–20 个 block；只允许文本或 base64 图片。
          items:
            $ref: '#/components/schemas/InitialContentBlock'
      required: [type, content]
    InitialContentBlock:
      oneOf:
        - title: text
          type: object
          properties:
            type:
              type: string
              enum: [text]
            text:
              type: string
              minLength: 1
          required: [type, text]
        - title: image
          type: object
          properties:
            type:
              type: string
              enum: [image]
            source:
              type: object
              properties:
                type:
                  type: string
                  enum: [base64]
                media_type:
                  type: string
                  enum: [image/jpeg, image/png, image/gif, image/webp]
                data:
                  type: string
                  description: Base64 字符串；每张图片解码后不超过 5 MiB。
              required: [type, media_type, data]
              additionalProperties: false
          required: [type, source]
          additionalProperties: false
    Metadata:
      type: object
      additionalProperties:
        type: string
      description: 客户端自定义元数据；省略时默认为空对象。最多 16 个键，键名长度不超过 64 字符，值必须是长度不超过 512 字符的字符串。
      maxProperties: 16
    ModelInput:
      title: Agent 模型
      example: glm-5.3
      oneOf:
        - title: 模型 ID
          type: string
          enum: [glm-5.3, glm-5.3-flash]
        - title: 模型配置
          type: object
          properties:
            id:
              type: string
              enum: [glm-5.3, glm-5.3-flash]
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
          required: [id]
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
        speed:
          type: string
          enum: [standard]
      required: [id, speed]
      additionalProperties: false
    AgentToolsetInput:
      description: >-
        工具集输入，三个变体；字段约束与 Agent API 的 AgentToolsetInput 完全一致（详见
        docs/agent/api/create-agent.md）：agent_toolset_20260601 / mcp_toolset / custom。
      oneOf:
        - title: agent_toolset_20260601
          type: object
          properties:
            type:
              type: string
              enum: [agent_toolset_20260601]
            default_config:
              nullable: true
              default: null
              description: 工具集默认配置；省略或传 null 时 enabled=true、permission_policy=always_allow。
            configs:
              type: array
              maxItems: 128
              default: []
              description: 逐工具覆盖；name 不得重复。
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
              nullable: true
              default: null
            configs:
              type: array
              maxItems: 128
              default: []
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
              description: 不得以 mcp__ 开头，且同一配置内不得重复。
            description:
              type: string
              minLength: 1
              maxLength: 4096
            input_schema:
              type: object
              properties:
                type:
                  type: string
                  enum: [object]
                properties:
                  type: object
                  additionalProperties: true
                required:
                  type: array
                  items:
                    type: string
              required: [type]
              additionalProperties: true
          required: [type, name, description, input_schema]
          additionalProperties: false
    AgentToolsetResponse:
      description: 归一化后的工具集回显；形态与 Agent API 的 AgentToolsetResponse 一致（default_config 与 configs 均为具体值）。
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
                type: object
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
                type: object
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
              type: object
          required: [type, name, description, input_schema]
          additionalProperties: false
    ToolDefaultConfigResponse:
      type: object
      properties:
        enabled:
          type: boolean
        permission_policy:
          type: object
          properties:
            type:
              type: string
              enum: [always_allow, always_ask]
          required: [type]
          additionalProperties: false
      required: [enabled, permission_policy]
      additionalProperties: false
    SkillReference:
      type: object
      properties:
        type:
          type: string
          enum: [custom]
          description: nano 仅支持 custom（当前所有者创建的 Skill）。
        skill_id:
          type: string
          minLength: 1
          description: Skill ID；必须存在。
        version:
          type: string
          minLength: 1
          description: 必须显式固定的 Skill 版本。
      required: [type, skill_id, version]
      additionalProperties: false
    McpServer:
      type: object
      description: 远程 MCP Server。name 同一配置内唯一，且必须与 tools 中恰好一个 mcp_toolset.mcp_server_name 相同。
      properties:
        type:
          type: string
          enum: [url]
        name:
          type: string
          minLength: 1
          maxLength: 255
        url:
          type: string
          format: uri
          pattern: ^https://
          maxLength: 2048
          description: 公开 HTTPS Streamable HTTP URL；不得包含凭据、fragment、空 query 或旧式 SSE 路径。
      required: [type, name, url]
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
      description: 标准 HTTP Bearer 认证；API Key 配置在 Worker 环境变量 API_KEY 中。
````
