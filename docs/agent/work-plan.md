# Agent 模块实现计划

本计划依据 [structure.md](structure.md) 定下的三层结构与目录布局，把 Agent 模块的实现拆成八个里程碑：一个地基阶段、六个按接口竖切的阶段、一个收尾阶段。每个竖切阶段交付一个可以实际调用、带完整测试的端点，对应 `docs/agent/api/` 下的一份接口文档。

## 总体思路

**按接口竖切。** 每个端点的实现都完整地穿过三层：协议层补上它需要的 schema 与纯函数，存储层补上它需要的仓储函数，传输层补上 handler 与 service 方法。做完一个里程碑，对应接口就处于可交付状态，不存在"做了一半的端点"。这样做的好处是每个阶段的验收都极其明确——拿接口文档逐条对照行为即可。

**顺序有依赖考量。** 创建接口放在第一个，因为它是第一片竖切，负责把模块骨架（routes、service、serialize、handlers 目录）立起来，后续五个端点基本是照抄这个骨架再填各自的语义。更新接口放在版本列表和归档之前，因为版本列表的测试数据需要多次更新才能产生，归档的回归测试需要"归档后更新被拒"这条端到端路径。获取和列表互相独立，谁先谁后都可以，必要时可以并行。

**纯函数先行、测试穷举。** 每个里程碑里属于 `@nano/shared` 的部分（schema 校验、归一化、合并）都先于集成代码完成并配齐 node 单测。这些纯函数承载的是 GLM 语义里最容易出错的部分（省略与 null 的区别、继承解析、按键合并），单测先行能在进入 Workers 集成测试之前就把语义钉死。

## 里程碑总览

| 里程碑 | 交付能力 | 对应接口文档 | 规模 |
| --- | --- | --- | --- |
| M0 地基 | 两张表与迁移就绪，协议与传输层公共设施就绪，探测路由受认证保护 | — | 中 |
| M1 创建 | `POST /v1/agents` | [create-agent.md](api/create-agent.md) | 大 |
| M2 获取 | `GET /v1/agents/{agentId}` | [get-agent.md](api/get-agent.md) | 小 |
| M3 列表 | `GET /v1/agents` | [list-agent.md](api/list-agent.md) | 中 |
| M4 更新 | `POST /v1/agents/{agentId}` | [update-agent.md](api/update-agent.md) | 大 |
| M5 版本列表 | `GET /v1/agents/{agentId}/versions` | [list-agent-versions.md](api/list-agent-versions.md) | 小 |
| M6 归档 | `POST /v1/agents/{agentId}/archive` | [archive-agent.md](api/archive-agent.md) | 小 |
| M7 收尾 | 全量验收，接口行为与文档逐条核对 | 全部 | 小 |

规模一列只是相对体量：标注"大"的里程碑（M1、M4）要么是从零立骨架，要么承载最复杂的业务语义；标注"小"的里程碑多数是在既有骨架上补一个仓储函数和一个 handler。

依赖关系如下，M2 与 M3 互相独立可以并行，M5 与 M6 的先后也可以对调（M6 的回归用例依赖 M4，不依赖 M5）：

```
M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7
          └────────┘（可并行）
```

## 通用工作约定

以下约定适用于每个里程碑，后文不再重复：

- **完成定义（DoD）**：`pnpm typecheck` 与 `pnpm test` 全绿；本里程碑新增测试全部通过；接口行为对照对应文档的"错误行为"表和请求/响应示例逐条核对过；`pnpm dev` 起本地服务后用 curl 冒烟通过。
- **提交粒度**：一个里程碑至少一个提交；M1、M4 这类大里程碑建议按 shared → db → api 分成三个提交，便于回溯。
- **迁移纪律**：凡是改了 `packages/db/src/schema.ts`，必须紧接着运行 `pnpm db:generate` 生成迁移并提交，不允许 schema 与迁移脱节。
- **测试先行部分**：涉及 `@nano/shared` 纯函数的任务，先写单测用例清单再写实现。

---

## M0 地基

这个阶段不产出任何业务端点，它要保证的是：后续六个竖切开始时，表已经建好、公共设施已经就位，不需要再为基础设施分心。

**存储层：**

- [x] 在 `packages/db/src/schema.ts` 中按 [schema.md](schema.md#drizzle-定义落地到-packagedbsrctschemats) 的定义写入 `agents` 与 `agent_versions` 两张表。JSON 列的 `$type<>()` 此阶段可先用宽松类型占位，M1 回填为 shared 推导的具体类型。
- [x] 新建 `packages/db/src/client.ts`，实现 `getDb(env)` 工厂，从 D1 绑定创建 drizzle 实例。
- [x] 运行 `pnpm db:generate` 生成首个迁移，`pnpm db:migrate:local` 在本地跑通，确认两张表按预期创建（含复合主键与 `idx_agents_created_at_id` 索引）。

**协议层：**

- [x] 新建 `packages/shared/src/api/error.ts`：把现有 `index.ts` 里的 `ApiError` 接口迁入，补充九种错误类型的枚举与 `ErrorResponse` 信封结构。
- [x] 新建 `packages/shared/src/api/pagination.ts`：定义 `Page<T>` 与分页查询参数类型。
- [x] `index.ts` 改为汇总导出，`API_VERSION` 保持原位或迁入 `api/`，对外导入路径不变。

**传输层：**

- [x] 新建 `apps/api/src/lib/errors.ts`：实现 `ApiError` 类（错误类型、HTTP 状态码、message、可选 details）以及错误类型到状态码的映射，并提供装配到 Hono 的 `onError` 处理器，统一渲染成带 `request_id` 的错误信封。
- [x] 新建 `apps/api/src/lib/request-id.ts`：每个请求生成 `request_id`，存入上下文并写入响应头。
- [x] 新建 `apps/api/src/lib/auth.ts`：校验 Bearer 凭证与环境变量 `API_KEY` 一致（常量时间比较），失败返回 401。所有 `/v1` 路由（含探测路由）注册在该中间件之后。
- [x] 新建 `apps/api/src/lib/body.ts`：JSON 请求体解析包装，坏 JSON 统一转为 `invalid_request_error`。
- [x] 在 `index.ts` 中装配上述中间件与 `onError`。
- [x] 适配现状：现有 `hello.test.ts` 因探测路由加了认证需要补 Authorization 头；`.dev.vars.example` 已有 `API_KEY` 示例，本地开发需要复制为 `.dev.vars`。

**验收：**

- [x] `pnpm typecheck`、`pnpm test` 全绿。
- [x] 集成测试：不带凭证访问 `GET /v1` 返回 401，响应体是 `{ type: "error", error: { type: "authentication_error", ... }, request_id }` 的完整信封；带正确凭证返回原有的探测信息，响应头带 `request_id`。
- [x] 本地 D1 中能用 sqlite 客户端看到两张表。

---

## M1 创建 Agent — `POST /v1/agents`

第一片竖切，除了实现创建接口本身，还负责把 `modules/agent` 的骨架立起来：routes、service、serialize、handlers 目录在里程碑结束时成形，后续五个端点照此复制。

**协议层：**

- [x] 新建 `packages/shared/src/agent/schemas.ts`：定义创建侧全部 schema——`AgentCreateRequest`、`ModelInput`（字符串与对象两种形态的 oneOf）、`AgentToolsetInput`（内置工具集 / mcp_toolset / custom 三个变体的 oneOf）、`SkillReference`、`McpServer`、`Metadata`、`ToolDefaultConfigInput`、`BuiltinToolConfigInput`、`McpToolConfigInput`、`CustomToolInputSchema`、`PermissionPolicy`，并导出 `z.infer` 类型。同时定义响应侧的 `AgentResponse` 类型。跨字段规则用 `superRefine` 挂上：mcp_toolset 必须与 mcp_servers 按名称一一对应、skills 非空时必须包含 agent_toolset_20260601、custom 工具名不以 `mcp__` 开头且配置内唯一、各数组不超上限。规则清单以 [create-agent.md](api/create-agent.md) 的 OpenAPI 为准。
- [x] 新建 `packages/shared/src/agent/normalize.ts`：实现 `normalizeAgentConfig`，把省略形态补全为展开形态（模型默认 effort 与 speed、工具集 default_config、configs 继承解析），输出类型即落库形态。
- [x] 单测：`schemas.test.ts` 覆盖创建侧全部校验规则，每种非法组合至少一个用例；`normalize.test.ts` 覆盖字符串简写展开、默认 effort 按模型区分（glm-5.3 → max、glm-5.3-flash → high）、继承解析、custom 工具原样透传。

**存储层：**

- [x] 新建 `packages/db/src/agent/ids.ts`：实现 `newAgentId()`，`agent_` 前缀加 UUIDv7（用 `crypto.getRandomValues` 自行实现，Workers 无内置 v7）。
- [x] 新建 `packages/db/src/agent/repo.ts`：实现 `createAgentWithFirstVersion`，两条插入放进同一个 D1 batch。
- [x] 把 `schema.ts` 中 JSON 列的占位类型回填为 shared 推导的具体类型。

**传输层：**

- [x] 建立 `apps/api/src/modules/agent/` 骨架：`routes.ts`（声明 `POST /v1/agents`）、`serialize.ts`（行转 API JSON，注入 `type: "agent"` 与 `multiagent: null`，时间戳转 ISO）、`service.ts`（首个方法 `createAgent`：校验 → 归一化 → 生成 ID → 落库）、`handlers/create-agent.ts`。
- [x] 在 `routes/v1.ts` 挂载 `v1.route("/agents", agentRoutes)`。

**测试与验收：**

- [x] 集成测试 `create-agent.test.ts`：创建成功返回 201，响应逐字段对照文档示例（特别注意归一化回显：`effort` 补为 max、`default_config` 补为 `{enabled: true, permission_policy: {type: "always_allow"}}`、`tools/skills/mcp_servers/metadata` 空态回显）；缺 name 或 model 返回 400；model 传非法值返回 400；name 超 256、system 超 100000、metadata 超 16 键分别返回 400；mcp_toolset 引用了不存在的 server 名返回 400；配置了 skills 但没有 agent_toolset 返回 400；不带凭证返回 401。
- [x] curl 冒烟：用文档"请求示例"原样创建一次，肉眼比对响应。

---

## M2 获取 Agent — `GET /v1/agents/{agentId}`

在 M1 骨架上补第一个只读端点，主要工作是一个 join 查询和一个 handler。

- [ ] `repo.ts` 新增 `findCurrentAgent(db, agentId)`：按 id 取 `agents` 行并以 `current_version` 关联取当前快照，查不到返回 null。
- [ ] `service.ts` 新增 `getAgent`：取不到抛 404 的 `ApiError`。
- [ ] 新建 `handlers/get-agent.ts` 并在 `routes.ts` 注册路由。
- [ ] 集成测试 `get-agent.test.ts`：创建后按返回的 id 获取，字段与创建响应完全一致；不存在的 id 返回 404 且响应是完整错误信封；path 参数格式任意（不存在的合法字符串）同样 404 而不是 500；不带凭证 401。

**验收**：响应形状与 [get-agent.md](api/get-agent.md) 的示例一致；404 行为符合文档"无权限与不存在同返回 404"的语义（单租户下即不存在 → 404）。

---

## M3 列出 Agent — `GET /v1/agents`

本里程碑的新增重点在传输层的分页设施，它是所有未来列表端点（sessions、versions 等）的公共基础。

- [ ] 新建 `apps/api/src/lib/pagination.ts`：解析 `limit/order/page`（limit 大于 100 截断、小于 1 抛 400，order 只接受 asc/desc）；游标 base64url 编解码，payload 带类型前缀（如 `agents:{createdAt}:{id}`），防止不同列表端点的游标被混用；解码失败抛 400。
- [ ] `repo.ts` 新增 `listAgentsPage(db, {limit, order, cursor})`：按 `(created_at, id)` keyset 查询，join 出每个 Agent 的当前版本快照，返回本页数据与下一页游标。
- [ ] `service.ts` 新增 `listAgents`；新建 `handlers/list-agent.ts`；响应体为 `{ data, next_page }`。
- [ ] 集成测试 `list-agent.test.ts`：造 25 个 Agent，默认参数返回 20 条、按创建时间倒序、`next_page` 非空；携带游标翻到第 2 页拿到剩余 5 条且 `next_page` 为 null；`limit=5` 生效；`limit=200` 被截断为 100；`limit=0` 返回 400；`order=asc` 正序；篡改游标内容返回 400；已归档的 Agent（用 helpers 直改库造一个）仍出现在列表中。

**验收**：分页行为逐条对照 [list-agent.md](api/list-agent.md) 与 [README.md](api/README.md) 的分页约定。

---

## M4 更新 Agent — `POST /v1/agents/{agentId}`

语义最重的里程碑。GLM 更新语义里所有容易出错的规则——省略与 null 的区别、数组整体替换、metadata 按键合并、无变化检测、乐观并发——都集中在这里，纯函数单测是本阶段的重点。

**协议层（先行）：**

- [ ] `schemas.ts` 补充 `AgentUpdateRequest`：`version` 可选正整数；标量字段可空语义（system/description 传 null 清空）；三个数组字段 nullable（null 即清空）；`MetadataPatch`（值为 null 表示删键）。superRefine 补规则：请求包含 mcp_toolset 时必须同请求提交 mcp_servers。
- [ ] 新建 `packages/shared/src/agent/merge.ts`：实现 `mergeAgentConfig(current, patch)` 与 `agentConfigEquals(a, b)`。
- [ ] `merge.test.ts` 穷举单测：省略字段保持不变；标量整体替换；system/description 传 null 清空而 name/model 不可清空；数组传新值整体替换、传 null 与空数组等价清空；metadata 新键新增、旧键覆盖、null 值删键、未提及键保留；合并结果与当前一致时 `agentConfigEquals` 为真；任何一处不同则为假。

**存储层：**

- [ ] `repo.ts` 新增 `insertNextVersionAndAdvance(db, {agentId, expectedVersion, config, now})`：同一 D1 batch 内插入 `expectedVersion + 1` 的版本行，并以 `WHERE id = ? AND current_version = ? AND archived_at IS NULL` 前移指针；受影响行为零时返回 false。

**传输层：**

- [ ] `service.ts` 新增 `updateAgent`，判定链按 structure.md 的顺序实现：取当前版本（null → 404）→ 已归档（400）→ 合并补丁 → 无变化则直接返回现有版本（不写库、version 不变）→ 请求带 version 时以该值为期望做 CAS，失败抛 409；不带 version 时先读当前值再走同一 CAS（覆盖式更新）。
- [ ] 新建 `handlers/update-agent.ts` 并注册路由。

**测试与验收：**

- [ ] 集成测试 `update-agent.test.ts`：只改 system 其余不变；改 model 字符串简写后 effort 按新模型默认值补全；system 传 null 清空；tools 传 `[]` 清空且 skills 非空时被校验拒绝（联动规则）；metadata 合并与删键；提交与当前完全相同的配置不升版本、`version` 不变、`updated_at` 不变；携带旧 version 在二次更新后重放返回 409；省略 version 时覆盖式更新成功；已归档 Agent 更新返回 400（用 helpers 直改库造归档状态）；请求带 mcp_toolset 但不带 mcp_servers 返回 400；不存在 的 id 返回 404。
- [ ] 并发冲突的测试技巧：集成测试里无法真并发，用"先取 expectedVersion，绕过接口直改库把 current_version 推高，再以旧值调更新"来模拟冲突路径。
- [ ] curl 冒烟：按 [update-agent.md](api/update-agent.md) 的请求示例走一遍携带 version 的更新。

---

## M5 列出 Agent 版本 — `GET /v1/agents/{agentId}/versions`

- [ ] `repo.ts` 新增 `listAgentVersionsPage(db, agentId, {limit, order, cursor})`：按 `version` keyset 扫描 `agent_versions`。
- [ ] `service.ts` 新增 `listAgentVersions`（Agent 不存在抛 404）；新建 `handlers/list-agent-versions.ts`。
- [ ] 序列化注意：每个条目的 `created_at/updated_at` 取版本行自身的时间戳，`archived_at` 取 `agents` 行的 Agent 级时间戳——这是 [list-agent-versions.md](api/list-agent-versions.md) 里"版本级时间戳、Agent 级归档"语义的落点。
- [ ] 集成测试 `list-agent-versions.test.ts`：对一个更新过两次的 Agent 列版本，得到 3 条、按 version 倒序；逐条断言是当时的完整配置快照（各版本的 system 与当时提交一致）；各版本时间戳不同；归档后（helpers 造）所有条目的 `archived_at` 回显同一个值；游标翻页；不存在的 Agent 返回 404。

---

## M6 归档 Agent — `POST /v1/agents/{agentId}/archive`

- [ ] `repo.ts` 新增 `archiveAgent(db, agentId, now)`：`WHERE archived_at IS NULL` 写入归档时间，天然幂等。
- [ ] `service.ts` 新增 `archiveAgent`：归档后返回当前完整 Agent（`archived_at` 已填充）；重复调用返回相同结果。
- [ ] 新建 `handlers/archive-agent.ts` 并注册路由。
- [ ] 集成测试 `archive-agent.test.ts`：归档后 `archived_at` 填充且后续获取不再变化；重复归档返回相同响应；归档后 `GET` 与 `GET /versions` 仍可读；列表中仍出现该 Agent；**端到端回归**：归档后调用更新接口返回 400（补上 M4 留下的真实路径验证）；不存在的 id 返回 404。

---

## M7 收尾与验收

- [ ] 对照六份接口文档做一次系统核对：每个端点的响应字段与 OpenAPI 的 required 列表一致；`type: "agent"` 与 `multiagent: null` 在所有响应中恒定；错误信封在所有非 2xx 中格式一致且带 `request_id`。
- [ ] 用 curl 按真实顺序走一遍生命周期：创建 → 获取 → 列表 → 更新（含一次 409）→ 列版本 → 归档 → 再次归档，全程对照文档示例。
- [ ] 全量 `pnpm test` 与 `pnpm typecheck`；确认迁移在全新本地库上从零应用成功。
- [ ] 复查 structure.md 中"依赖规则"三条约束未被违反（modules 无横向引用、shared 零内部依赖、db 不 import api），可以用一次 grep 或加 lint 规则固化。

---

## 风险与注意事项

以下几处是实现时最可能踩坑的地方，提前列出：

- **D1 batch 的原子性**依赖"多条语句放进同一次 batch 调用"，`insertNextVersionAndAdvance` 与 `createAgentWithFirstVersion` 都必须遵守，散着写就不是事务了。
- **409 与 400 的分界**：CAS 受影响行为零有两种原因——version 不匹配（409）与已归档（400）。repo 返回 false 时 service 需要重读一次 agents 行区分这两种情况，不能笼统抛 409。
- **无变化检测的比较基准**：必须拿"归一化后的候选配置"与"当前版本快照"比，而不是拿原始请求比，否则用户提交已补全默认值的配置会被误判为有变化。
- **游标防混用**：不同列表端点的游标 payload 带类型前缀，防止把 agents 的游标传给 versions 端点时静默返回错误数据。
- **zod 的 unknown 键**：GLM 的 schema 都是 `additionalProperties: false`，zod 侧用 `.strict()` 对齐，否则多传字段的行为会与文档不符。
