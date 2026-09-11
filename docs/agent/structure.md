# Agent 模块代码目录结构

本文档描述 Agent 模块的代码目录结构，把 [schema.md](schema.md) 中设计的两张表和 [api/](api/) 中定义的六个端点，落地为一份可以直接照着建文件的代码组织方案。

Agent 是这个项目里的第一个资源模块。它既然开了头，就有义务把目录结构定成后续所有资源模块都能照抄的样板：等将来实现 session、environment 时，开发者不需要重新思考代码该放在哪里，照着 Agent 模块的骨架在同样的位置补齐文件即可。因此本文档不只回答"Agent 的代码放在哪"，还会说明"每一层为什么这样划分"——后者才是真正能复制到其他资源上的部分。

## 设计目标

这份结构设计想同时达成三件事，后面所有具体决定都可以追溯到这三条：

**分层清晰。** 每一层只对一类问题负责：协议层回答"数据长什么样"，存储层回答"数据怎么存取"，传输层回答"HTTP 请求如何进出"。一个典型变更（比如给 Agent 增加一个字段）会按固定的顺序穿过这三层——先改协议层的 schema，再改存储层的表与仓储，最后改传输层的接口——而不是在同一个文件里纠缠不清。

**资源同构。** 不同资源模块内部保持完全相同的目录形态。看懂了 Agent 模块的人，打开 session 模块不需要任何重新适应；review 代码时也能凭文件位置直接判断一段代码的职责边界。

**纯逻辑可独立测试。** 归一化、配置合并、无变化比较这一类不含任何 IO 的纯函数，全部放在 `@nano/shared` 里。它们只依赖入参，用 node 环境的 vitest 直接就能跑，不需要启动 Workers 运行时和 D1，测试又快又稳定。真正需要 Workers 运行时的集成测试则集中在 `apps/api`，两类测试各司其职。

## 分层与依赖规则

代码分三层，依赖方向严格单向，从外到内依次是传输层、存储层、协议层：

```
apps/api            packages/db            packages/shared
(传输层: Hono)  →   (存储层: Drizzle/D1)  →  (协议层: zod / 类型)
```

**传输层 `@nano/api`** 对应 `apps/api`，是部署到 Cloudflare 的 Worker 本体。它持有 Hono 应用，负责路由声明、认证、request_id 生成、错误信封渲染、分页游标的编解码，以及把数据库行序列化成 API JSON。它不定义协议类型，也不直接写 SQL——所有 SQL 都来自 `@nano/db` 暴露的仓储函数。

**存储层 `@nano/db`** 对应 `packages/db`，封装 Drizzle 表定义与全部 D1 查询。它向上暴露的是带业务语义的仓储函数（例如"插入新版本并前移指针"），向下则是整个代码库唯一的 SQL 出处。它完全不知道 HTTP 的存在：没有状态码，没有错误信封，只有返回值和抛出的普通错误。

**协议层 `@nano/shared`** 对应 `packages/shared`，是请求与响应结构的唯一权威定义，前后端共用。除 zod 之外它不依赖任何内部包，是整个依赖图的终点。归一化与合并这类纯函数也放在这一层，因为它们描述的是协议语义——"省略的字段如何补全""更新请求如何合并"——与运行环境无关。

依赖方向之外，还有三条约束需要遵守：

- `apps/api/src/modules/` 下的资源模块之间禁止横向引用。Agent 模块不 import session 模块的任何东西；资源之间真正需要共享的逻辑，要么下沉到 `@nano/shared`，要么提升到 `apps/api/src/lib/`。
- 内部包不构建，遵循 README 的既有约定：`exports` 直接指向 TS 源码，wrangler 打包和 vitest 都直接消费源文件。
- `packages/db` 中 JSON 列的 `$type<>()` 引用 `@nano/shared` 推导的类型。数据库的存储形态和 API 的表达形态因此永远来自同一份定义，不会出现两边各写一份、慢慢漂移的情况。

## 目录树

```
nano-managed-agent/
├── apps/
│   └── api/                              # @nano/api — Cloudflare Worker(Hono)
│       ├── src/
│       │   ├── index.ts                  # Worker 入口: 创建 Hono 应用, 装配全局中间件与错误处理, 挂载 /v1
│       │   ├── env.ts                    # Cloudflare.Env 类型别名, 由 wrangler types 生成
│       │   ├── lib/                      # 与具体资源无关的横切设施, 所有资源模块共用
│       │   │   ├── errors.ts             # ApiError 类与错误类型到 HTTP 状态码的映射, 错误信封的唯一出处
│       │   │   ├── request-id.ts         # 为每个请求生成 request_id, 存入上下文并在错误信封中回显
│       │   │   ├── auth.ts               # Bearer API_KEY 校验中间件, 失败时返回 401
│       │   │   ├── pagination.ts         # 解析 limit/order/page 参数, 编解码对客户端不透明的 keyset 游标
│       │   │   └── body.ts               # JSON 请求体解析包装, 把坏 JSON 统一转为 invalid_request_error
│       │   ├── modules/
│       │   │   └── agent/                # Agent 资源模块, 后续资源模块照此结构复制
│       │   │       ├── routes.ts         # Hono 子路由: 声明六个端点并绑定到对应 handler
│       │   │       ├── handlers/         # 每个端点一个文件, 与 docs/agent/api/ 下的文档一一对应
│       │   │       │   ├── create-agent.ts        # POST /v1/agents
│       │   │       │   ├── list-agent.ts          # GET  /v1/agents
│       │   │       │   ├── get-agent.ts           # GET  /v1/agents/{agentId}
│       │   │       │   ├── update-agent.ts        # POST /v1/agents/{agentId}
│       │   │       │   ├── list-agent-versions.ts # GET  /v1/agents/{agentId}/versions
│       │   │       │   └── archive-agent.ts       # POST /v1/agents/{agentId}/archive
│       │   │       ├── service.ts        # 业务编排: 归档检查、合并补丁、无变化检测、并发冲突判定
│       │   │       └── serialize.ts      # 数据库行转 API JSON: 时间戳转 ISO, 注入 type 与 multiagent 字段
│       │   └── routes/
│       │       └── v1.ts                 # /v1 组合点: 探测路由, 并把各资源模块的子路由挂载上来
│       ├── test/
│       │   ├── hello.test.ts             # 现有的探活测试
│       │   └── agents/                   # 集成测试: 真实 Workers 运行时加 miniflare D1
│       │       ├── helpers.ts            # 测试夹具: 应用迁移, 构造合法 payload, 断言错误信封
│       │       ├── create-agent.test.ts
│       │       ├── list-agent.test.ts
│       │       ├── get-agent.test.ts
│       │       ├── update-agent.test.ts
│       │       ├── list-agent-versions.test.ts
│       │       └── archive-agent.test.ts
│       ├── wrangler.jsonc
│       └── vitest.config.ts
├── packages/
│   ├── shared/                           # @nano/shared — 协议层, 除 zod 外零依赖
│   │   ├── src/
│   │   │   ├── index.ts                  # 汇总导出, 现有的 API_VERSION 与 ApiError 类型迁入 api/
│   │   │   ├── api/                      # 与具体资源无关的协议设施
│   │   │   │   ├── error.ts              # 错误类型枚举与 ErrorResponse 结构定义
│   │   │   │   └── pagination.ts         # Page<T> 与分页查询参数的类型定义
│   │   │   └── agent/                    # Agent 资源的协议定义
│   │   │       ├── schemas.ts            # 全部请求与响应的 zod schema 及推导类型, 含跨字段校验
│   │   │       ├── normalize.ts          # 归一化纯函数: 补全默认值, 解析继承, 输出即落库形态
│   │   │       └── merge.ts              # 合并纯函数: 更新语义与无变化比较
│   │   └── test/agent/                   # 纯函数单测, node 环境运行, 不需要 Workers
│   │       ├── schemas.test.ts
│   │       ├── normalize.test.ts
│   │       └── merge.test.ts
│   └── db/                               # @nano/db — 存储层, 不感知 HTTP
│       ├── drizzle.config.ts             # 现有的 drizzle-kit 配置, pnpm db:generate 使用
│       ├── migrations/                   # drizzle-kit 生成的 SQL 迁移文件
│       └── src/
│           ├── index.ts                  # 汇总导出
│           ├── client.ts                 # getDb(env) 工厂: 从 D1 绑定创建 drizzle 实例
│           ├── schema.ts                 # 表定义, 一期存放 agents 与 agent_versions 两张表
│           └── agent/
│               ├── ids.ts                # newAgentId(): 生成 agent_ 前缀加 UUIDv7 的资源标识
│               └── repo.ts               # 全部 SQL 的唯一出处, 六个仓储函数对应六条读写路径
```

## 各层内部结构

### packages/shared：协议层

`src/api/` 存放与具体资源无关的协议设施。`error.ts` 定义错误类型枚举（`invalid_request_error`、`authentication_error` 等九种）与 `ErrorResponse` 信封结构；`pagination.ts` 定义 `Page<T>` 与分页查询参数的类型。现有的 `ApiError` 接口和 `API_VERSION` 常量从 `index.ts` 迁入这里，`index.ts` 退化为汇总导出。

`src/agent/` 是 Agent 资源的协议定义，共三个文件。

**`schemas.ts`** 是 Agent 资源所有请求与响应结构的唯一权威定义。创建请求、更新请求、Agent 响应对象、模型配置、工具集的三个变体（内置工具集、MCP 工具集、自定义工具）、Skill 引用、MCP Server 声明、metadata，全部以 zod schema 的形式定义在这里，并通过 `z.infer` 导出对应的 TypeScript 类型。长度限制与枚举取值这类单字段约束直接写在 schema 上；跨字段约束——例如 `mcp_toolset` 必须与 `mcp_servers` 按名称一一对应、配置了 `skills` 就必须包含 `agent_toolset_20260601`、custom 工具名不得以 `mcp__` 开头且配置内不得重复——通过 `superRefine` 挂在同一个 schema 上，完整规则清单见 [schema.md](schema.md)。校验逻辑跟着 schema 走，任何调用方解析请求时自动获得同一套校验。

**`normalize.ts`** 负责把用户提交的、允许大量省略的配置补全成完全展开的形态。API 允许 `model` 传字符串简写、允许省略 `effort`、允许工具集不写 `default_config`、允许逐工具覆盖只写 `name` 而其余字段留空表示继承。归一化函数把这些输入统一解析成具体值：`"glm-5.3"` 展开为 `{ id: "glm-5.3", effort: "max", speed: "standard" }`，未配置的工具集补上 `enabled: true` 与 `always_allow`，留空的覆盖项回填为继承后的结果。归一化的输出同时是数据库的存储形态和 API 的响应形态——这正是 [schema.md](schema.md) 中"落库即归一化"原则的实现位置。

**`merge.ts`** 实现更新语义。更新请求只提交想改的字段，merge 函数接收当前版本的完整配置与本次补丁，按 GLM 的规则合并出候选配置：标量字段（model、system、name、description）整体替换，其中 system 与 description 允许传 null 清空；数组字段（tools、mcp_servers、skills）整体替换，传 null 或空数组即全部清空；metadata 单独按键合并，提交的键覆盖旧值，未提交的键保留原值，值为 null 的键被删除。同文件中的 `agentConfigEquals` 用于无变化检测：如果合并出的候选配置与当前版本逐字段一致，更新接口就不生成新版本，直接返回现状。把这套语义写成纯函数的最大好处是可以穷举测试——"省略保持不变、null 清空、空数组清空"这些规则的各种组合，都能在 node 单测里逐条断言。

### packages/db：存储层

`src/schema.ts` 一期只存放 Agent 的两张表：`agents` 与 `agent_versions`，完整定义见 [schema.md](schema.md)。等资源数量多起来之后再按资源拆分成 `schema/agent.ts`、`schema/session.ts` 加一个汇总导出，这是"演进预留"一节的内容。

`src/client.ts` 提供一个极小的工厂函数 `getDb(env)`，从 Worker 的 D1 绑定创建 drizzle 实例。仓储函数统一接收这个实例作为第一个参数，自身保持无状态，测试时可以直接注入 miniflare 的实例。

`src/agent/ids.ts` 生成资源标识：`agent_` 前缀加上 UUIDv7。v7 的时间戳前缀让 ID 天然按创建时间有序，形态上与 GLM 的 `agent_0191…` 一致；Workers 环境没有现成的 uuidv7 实现，这里用 `crypto.getRandomValues` 自行拼装。

`src/agent/repo.ts` 是全部 SQL 的唯一出处，对外暴露六个函数，每个函数对应一条完整的业务读写路径：

```ts
createAgentWithFirstVersion(db, { id, config, now })
findCurrentAgent(db, agentId)
listAgentsPage(db, { limit, order, cursor })
listAgentVersionsPage(db, agentId, { limit, order, cursor })
insertNextVersionAndAdvance(db, { agentId, expectedVersion, config, now })
archiveAgent(db, agentId, now)
```

- `createAgentWithFirstVersion` 在一个 D1 batch 里同时写入 `agents` 行和 version 为 1 的 `agent_versions` 行，对应创建端点；两行要么都写入成功，要么都不生效。
- `findCurrentAgent` 按 id 取 `agents` 行，并用 `current_version` 关联取出当前配置快照，是获取、更新、归档三个端点的共同入口；查不到时返回 null，由上层决定转成 404。
- `listAgentsPage` 与 `listAgentVersionsPage` 分别按 `(created_at, id)` 和 `version` 做 keyset 分页。游标的编解码在传输层完成后，以普通参数的形式传入，repo 本身不关心游标的内容。
- `insertNextVersionAndAdvance` 是并发正确性的关键。它在同一个 D1 batch 里先插入 version 为 `expectedVersion + 1` 的新快照，再以 `WHERE id = ? AND current_version = ? AND archived_at IS NULL` 的条件前移 `agents` 表的指针；受影响行数为零，说明版本号不匹配或者 Agent 已归档，函数返回 false，由 service 层决定转成 409 还是 400。
- `archiveAgent` 以 `WHERE archived_at IS NULL` 的条件写入归档时间，天然幂等：重复归档不会改动任何数据，调用方直接返回当前状态即可。

事务边界被刻意收敛在 repo 内部：`createAgentWithFirstVersion` 与 `insertNextVersionAndAdvance` 各自内部的多条语句都必须放在同一个 D1 batch 里（D1 的 batch 是隐式事务），调用方因此永远不需要关心事务编排，service 层调用的始终是一个完整的原子操作。

### apps/api：传输层

传输层自己再分成三块：全局入口、横切设施（`lib/`）和资源模块（`modules/`）。

全局入口有两个文件。`index.ts` 创建 Hono 应用，装配 request-id 与 auth 中间件、注册 `app.onError` 错误处理，然后把 `routes/v1.ts` 挂载到根路径——它是所有全局行为的装配点，但不包含任何资源相关的代码。`routes/v1.ts` 是 `/v1` 的组合点，除了现有的探测路由外，只做一件事：把各资源模块的子路由挂载上来（`v1.route("/agents", agentRoutes)`）；将来新增资源模块时，全局入口需要改动的只有这里的一行。

`lib/` 下是五个与具体资源无关的横切设施，任何资源模块的列表接口和错误路径都会用到它们：

- **`errors.ts`** 定义整个服务唯一的错误类型 `ApiError`，携带错误类型（九种之一）、HTTP 状态码、message 与可选的 details；`index.ts` 里装配的 `app.onError` 把它统一渲染成 `{ type: "error", error, request_id }` 信封。handler 与 service 只抛 `ApiError`，不自行构造错误响应，错误格式因此在全局只有一个出处。
- **`request-id.ts`** 在每个请求进入时生成一个 request_id（错误信封里回显的那个），存入 Hono 的请求上下文，并写入响应头，方便客户端与服务端日志对照。
- **`auth.ts`** 校验 Authorization 头中的 Bearer 凭证是否与环境变量 `API_KEY` 一致（使用常量时间比较，避免时序侧信道），不一致时以 401 结束请求。所有 `/v1` 路由都注册在这个中间件之后。
- **`pagination.ts`** 解析分页参数并编解码游标：limit 大于 100 时截断为 100，小于 1 时抛出 invalid_request_error；游标是 base64url 编码的 keyset 定位信息（Agent 列表用创建时间加 id，版本列表用版本号），对客户端保持不透明。分页约定是所有列表端点共享的，所以它放在 `lib/` 而不是某个资源模块里。
- **`body.ts`** 包装 JSON 请求体的解析，把"请求体不是合法 JSON"这类传输层错误统一转换成 invalid_request_error，避免每个 handler 重复写 try/catch。

`modules/agent/` 是 Agent 资源模块本体，内部有四种角色。

**`routes.ts`** 是一个 Hono 子路由，声明六个端点并绑定到对应的 handler，不包含任何逻辑。

**`handlers/`** 目录下每个端点一个文件，文件名与 `docs/agent/api/` 下的文档名严格一致（`create-agent.ts` 对应 `create-agent.md`），从文档定位实现、从实现定位文档都不需要查表。handler 刻意保持很薄，只做三件事：用 shared 的 schema 解析并校验入参，调用 service 的对应方法，把返回结果交给 serialize 后以 JSON 响应。业务判断和 SQL 都不在这里出现。

**`service.ts`** 是业务编排层，Agent 生命周期的规则在这里收口。以最复杂的 `updateAgent` 为例，它的判定顺序是：先取当前版本，取不到说明 Agent 不存在，抛出 404；再检查归档状态，已归档的 Agent 拒绝更新，抛出 400；然后用 shared 的 merge 函数把请求补丁合并进当前配置；接着做无变化检测，合并结果与当前版本完全一致时不写库，直接返回现有版本；最后调用仓储的 CAS 操作写入新版本，CAS 失败（说明期间有其他调用者改过）抛出 409。这一串判定顺序本身就是 [update-agent.md](api/update-agent.md) 文档语义的代码化。

**`serialize.ts`** 负责数据库行到 API JSON 的最后一跳：时间戳从 `Date` 转成 ISO 8601 UTC 字符串，列名从数据库的 snake_case 映射为 API 的字段名，并注入两个不落库的固定字段——`type: "agent"` 与 `multiagent: null`。序列化只此一处，保证六个端点回显的 Agent 形状完全一致。

## 一个请求的完整旅程

以更新 Agent（`POST /v1/agents/{agentId}`）为例，一个请求从头到尾要经过的环节如下：

1. Worker 入口 `index.ts` 接到请求。request-id 中间件先生成 `request_id` 存入请求上下文；auth 中间件接着校验 Bearer 凭证，不通过则以 401 结束。
2. 路由经过 `routes/v1.ts` 进入 `modules/agent/routes.ts`，命中 `handlers/update-agent.ts`。
3. handler 用 `@nano/shared` 的 `AgentUpdateRequest` schema 解析请求体。单字段约束与跨字段约束都在这一步完成，非法请求以 400 结束，错误信息带上具体的字段路径。
4. handler 调用 `service.updateAgent`。service 依次执行取当前版本、归档检查、合并补丁、无变化检测，最后调用 `@nano/db` 的 `insertNextVersionAndAdvance` 在一个事务里完成写入。任何一个环节不满足条件，都会以 `ApiError` 的形式抛出，对应 404、400 或 409。
5. 成功路径上，service 返回新版本的数据库行，`serialize.ts` 把它转换成 API JSON，handler 以 200 返回。
6. 如果任何环节抛出了 `ApiError`，`app.onError` 兜底接住，统一渲染成带 `request_id` 的错误信封。成功与失败最终都只有一种出口格式。

## 测试策略

测试分两层，分别对应两类代码。

纯函数单测放在 `packages/shared/test/agent/`，用 node 环境的 vitest 运行，覆盖三块内容：schemas 的跨字段校验（构造各种非法组合并断言被拒绝）、normalize 的默认值补全与继承解析、merge 的合并语义与无变化比较。这些测试毫秒级完成，是开发时的第一道反馈。

集成测试放在 `apps/api/test/agents/`，通过 `@cloudflare/vitest-plugin` 在真实 Workers 运行时里运行，每个用例开始前由 `helpers.ts` 对 miniflare 提供的 D1 应用 `packages/db/migrations` 下的真实迁移。测试直接打 HTTP 接口，覆盖六个端点的完整契约：创建与响应回显的形状、分页游标的往返、更新时的 409 并发冲突、无变化时不升版本、metadata 的按键合并、归档的幂等与归档后拒绝更新，以及 404 行为。`helpers.ts` 同时提供合法 payload 的工厂函数和统一的错误信封断言，避免每个测试文件各自拼装样板。

## 新增资源模块的扩展路径

以将来实现 session 资源为例，需要动的位置按依赖顺序是：

1. 先写文档：`docs/session/schema.md` 定义表结构，`docs/session/api/` 下按端点写接口文档。
2. 然后是协议层：在 `packages/shared/src/session/` 下建立 `schemas.ts`、`normalize.ts`、`merge.ts`（如果该资源没有版本合并语义，merge 可以省略）。
3. 接着是存储层：在 `packages/db/src/schema.ts` 里加表，建立 `packages/db/src/session/{ids,repo}.ts`，运行 `pnpm db:generate` 生成迁移。
4. 再是传输层：建立 `apps/api/src/modules/session/`，按 Agent 模块的骨架补齐 `routes.ts`、`handlers/`、`service.ts`、`serialize.ts`，并在 `routes/v1.ts` 挂载。
5. 最后补测试：`packages/shared/test/session/` 与 `apps/api/test/sessions/` 同构补齐。

## 演进预留

有两个已知的扩展点，现在不必做，但结构上已经留好了位置：

- `packages/db/src/schema.ts` 目前只放 Agent 的两张表。等资源数量超过两三个，再拆成 `schema/agent.ts`、`schema/session.ts` 加一个汇总导出的 barrel，对外导入路径保持不变。
- `modules/agent/service.ts` 目前只被 Worker 消费。如果将来出现第二个消费方（例如 CLI 或控制台前端），可以把 service 连同它对 shared 与 db 的依赖整体下沉为新包 `@nano/agent`，依赖方向不变，传输层只需要改一处 import。
