# 更新 Session

> 更新 Session 的标题、元数据或 Agent 工具配置。`title` / `metadata` 任意状态可更新；`agent.tools` / `agent.mcp_servers` 仅 `idle` 状态可更新（整体替换）。其余字段（model、system、skills、vault_ids、environment、resources）创建即冻结。已归档 Session 不可修改。

## 请求示例

```bash
curl -sS "http://127.0.0.1:8787/v1/sessions/$SESSION_ID" \
  -H "Authorization: Bearer $NANO_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "title": "Q2 sales deep-dive",
    "metadata": {"sprint": "24"},
    "agent": {
      "tools": [
        {
          "type": "agent_toolset_20260601",
          "configs": [{"name": "bash", "permission_policy": {"type": "always_ask"}}]
        }
      ]
    }
  }'
```

响应 `200`：完整的 Session 对象（结构同 [get-session.md](get-session.md)），`agent.tools` 已替换为新值，`title` / `metadata` 已合并，`updated_at` 刷新。

## 更新规则

| 字段 | 规则 |
| --- | --- |
| **title** | 任意状态可更新；标量替换，传 null 清空，省略保持不变。 |
| **metadata** | 任意状态可更新；键级合并——提交键覆盖、值为 null 删键、未提及键保留，限制与创建相同（16 键、key ≤ 64、value ≤ 512）。 |
| **agent.tools** | 仅 `idle` 可更新（否则 409，语义标记 `session_not_idle`，需先打断执行）；整体替换进会话固化的 Agent 快照。 |
| **agent.mcp_servers** | 仅 `idle` 可更新；整体替换。与 `agent.tools` 的 `mcp_toolset` 引用必须在替换后的最终配置上一一对应。 |

- `model` / `system` / `skills` / `vault_ids` / `environment_id` / `resources` / `initial_events` 创建时冻结，出现在请求里即返回 400（未知或不可变字段）。
- `agent` 对象内只允许 `tools` 与 `mcp_servers`，且至少提供一个；请求体至少提供一个顶层字段（空对象返回 400）。
- `mcp_toolset` 的引用一致性在**替换后的最终配置**上校验：最终配置中的每个 `mcp_toolset.mcp_server_name` 必须与恰好一个 `mcp_servers[].name` 同名对应，反之亦然。
- 无变化更新（合并结果与当前完全一致）不写库，`updated_at` 不变，直接返回现状。

## 错误行为

| 状态码 | error.type | 场景 |
| --- | --- | --- |
| 400 | `invalid_request_error` | 请求体为空对象 / `agent` 为空对象、提交了冻结字段、`title` 超 256、metadata 超限、`tools` ≤ 128 / `mcp_servers` ≤ 20 超限、替换后 mcp 映射不一致、configs 内 name 重复等 |
| 401 | `authentication_error` | 缺少或无效的 Bearer 凭证 |
| 404 | `not_found_error` | Session 不存在 |
| 409 | `invalid_request_error` | 已归档（`session_archived`）；`agent.tools` / `agent.mcp_servers` 存在且 `status != idle`（`session_not_idle`，nano 一期恒 idle，此分支待二期运行时就位后生效） |

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
  /v1/sessions/{sessionId}:
    post:
      tags: [Session]
      summary: 更新 Session
      description: >-
        更新 Session 的标题、元数据或 Agent 工具配置。title / metadata 任意状态可更新；agent.tools /
        agent.mcp_servers 仅 idle 状态可更新且整体替换；其余字段创建即冻结。已归档 Session 不可修改（409）。
      operationId: updateSession
      parameters:
        - $ref: '#/components/parameters/Authorization'
        - name: sessionId
          in: path
          required: true
          description: sessionId 资源标识。
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/SessionUpdateRequest'
            example:
              title: Q2 sales deep-dive
              agent:
                tools:
                  - type: agent_toolset_20260601
                    configs:
                      - name: bash
                        permission_policy:
                          type: always_ask
      responses:
        '200':
          description: 请求成功。
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
    SessionUpdateRequest:
      type: object
      properties:
        title:
          type: string
          nullable: true
          maxLength: 256
          description: 替换标题；null 表示清空，省略时保持不变。
        metadata:
          type: object
          nullable: true
          maxProperties: 16
          additionalProperties:
            type: string
            nullable: true
          description: 元数据补丁；省略整个字段时保持不变，键值为 null 时删除对应键。最多 16 个键，键 ≤ 64 字符，字符串值 ≤ 512 字符。
        agent:
          type: object
          description: 只允许覆盖 tools 与 mcp_servers，且至少提供一个字段；两者涉及 MCP 时须一起提交并保持一一对应。
          properties:
            tools:
              type: array
              nullable: true
              maxItems: 128
              description: >-
                整体替换会话的工具覆盖；null 或空数组表示清空。若包含 mcp_toolset，最终配置必须与 mcp_servers
                一一对应。元素结构同 create-session.md 的 AgentToolsetInput（agent_toolset_20260601 / mcp_toolset / custom）。
              items:
                type: object
            mcp_servers:
              type: array
              nullable: true
              maxItems: 20
              description: 整体替换会话的 MCP Server；仅能与 tools 同时提交，最终配置必须与 mcp_toolset 一一对应。元素结构同 create-session.md 的 McpServer。
              items:
                type: object
          additionalProperties: false
          minProperties: 1
      additionalProperties: false
      minProperties: 1
    Session:
      description: 完整字段与嵌套结构见 create-session.md；此处列一级字段。
      type: object
      properties:
        id:
          type: string
        type:
          type: string
          enum: [session]
        agent:
          type: object
          description: 固化的 Agent 配置快照；tools / mcp_servers 已被本次更新整体替换。
        environment_id:
          type: string
        status:
          type: string
          enum: [idle, running, rescheduling, terminated]
        title:
          type: string
          nullable: true
        metadata:
          type: object
          additionalProperties:
            type: string
        resources:
          type: array
          items:
            type: object
        vault_ids:
          type: array
          items:
            type: string
        outcome_evaluations:
          type: array
          items:
            type: object
        stats:
          type: object
        usage:
          type: object
        budget:
          type: object
          nullable: true
          enum: [null]
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
        archived_at:
          type: string
          nullable: true
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
            message:
              type: string
            details:
              type: object
              additionalProperties: true
          required: [type, message]
          additionalProperties: false
        request_id:
          type: string
      required: [type, error, request_id]
      additionalProperties: false
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      description: 标准 HTTP Bearer 认证；API Key 配置在 Worker 环境变量 API_KEY 中。
````
