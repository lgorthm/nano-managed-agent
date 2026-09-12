# Session 模块代码目录结构

本文档描述 Session 模块的代码目录结构，把 [schema.md](schema.md) 中设计的两张表和 [api/](api/) 中定义的十个端点，落地为一份可以直接照着建文件的代码组织方案。

Session 是仓库里的第五个资源模块（前四个：agent、skill、file、environment），分层规则、目录形态与 [Agent 模块结构](../agent/structure.md) 完全一致——传输层（`apps/api`）、存储层（`packages/db`）、协议层（`packages/shared`）单向依赖，模块间禁止横向引用。因此本文档不再重复三层划分的论证，只讲 Session 与既有模块**不同**的部分：跨资源的引用解析、纯函数的两类语义、以及为二期运行时（`SESSION_DO` / `agent-loop`）预留的位置。

## Session 模块的三个特殊点

**它是第一个「组合者」。** Agent 只依赖自身表；Session 创建时要读 `agents` + `agent_versions`（解析钉住的版本与覆盖）、读 `environments`（校验未归档并固化快照）、读 `files`（校验挂载引用）、读 `skill_versions`（校验 skills 引用）。这些跨模块读取一律通过各模块的**仓储函数**完成（`findCurrentAgent`、`findAgentVersion`、`findEnvironment`、`findFilesByIds`、`findMissingSkillVersionPairs`），缺失的函数在各自模块内补齐——Session 模块不写针对他模块表的 SQL，也不 import 他模块的 service。这是「模块间禁止横向引用」约束的自然推论：依赖的是存储层的既有契约，而不是别人的业务编排。

**它的纯函数是两类语义。** Agent 模块的 shared 纯函数只有一类（配置归一化与合并）；Session 增加了第二类——**引用解析**（`resolveSessionAgent`：版本配置 ⊕ 覆盖 → 最终配置）与**路径归一化**（`normalizeMountPath`：挂载路径消解、逃逸检测、重叠判定）。两者都是「相同输入永远相同输出、无 IO」的协议语义，放 `@nano/shared` 用 node 单测穷举，尤其是 mount_path 的 `..` 消解与前缀重叠，边界用例多且最容易错。

**它有一个二期运行时的预留位。** 一期 Session 是纯元数据控制面；二期的事件历史与 SSE 推流落在 `SESSION_DO` Durable Object，Agent 循环落在 `agent-loop` Workflow（`wrangler.jsonc` 已注释预留绑定）。它们的代码位置与依赖方向现在就定下来（见文末），避免二期开工时把运行时代码塞进模块目录破坏分层。

## 目录树

```
nano-managed-agent/
├── apps/
│   └── api/                                   # @nano/api — 传输层(Hono)
│       ├── src/
│       │   ├── modules/
│       │   │   ├── session/                   # Session 资源模块(照 agent 模块骨架复制)
│       │   │   │   ├── routes.ts              # 子路由: 声明 10 个端点并绑定 handler
│       │   │   │   ├── handlers/              # 每端点一个文件, 与 docs/session/api/ 文档一一对应
│       │   │   │   │   ├── create-session.ts            # POST   /v1/sessions
│       │   │   │   │   ├── list-sessions.ts             # GET    /v1/sessions
│       │   │   │   │   ├── get-session.ts               # GET    /v1/sessions/{sessionId}
│       │   │   │   │   ├── update-session.ts            # POST   /v1/sessions/{sessionId}
│       │   │   │   │   ├── archive-session.ts           # POST   /v1/sessions/{sessionId}/archive
│       │   │   │   │   ├── delete-session.ts            # DELETE /v1/sessions/{sessionId}
│       │   │   │   │   ├── add-session-file-resource.ts # POST   /v1/sessions/{sessionId}/resources
│       │   │   │   │   ├── list-session-resources.ts    # GET    /v1/sessions/{sessionId}/resources
│       │   │   │   │   ├── get-session-file-resource.ts # GET    /v1/sessions/{sessionId}/resources/{resourceId}
│       │   │   │   │   └── delete-session-file-resource.ts # DELETE /v1/sessions/{sessionId}/resources/{resourceId}
│       │   │   │   ├── service.ts              # 业务编排: 引用解析调度、归档/idle 门禁、无变化检测
│       │   │   │   └── serialize.ts            # 行转 API JSON: 注入固定回显字段, 拼装 resources 子查询
│       │   │   └── ...
│       │   ├── runtime/                        # 二期预留: 会话运行时(一期不建目录)
│       │   │   ├── do/session-do.ts            # SESSION_DO: 事件历史存储 + SSE 推流(每会话一个实例)
│       │   │   └── workflows/agent-loop.ts     # agent-loop: 每轮 Agent 循环的持久化执行
│       │   └── ...
│       └── test/
│           └── sessions/                       # 集成测试(真实 Workers 运行时 + miniflare D1)
│               ├── helpers.ts                  # 夹具: 建前置 agent/environment/file 的工厂
│               ├── create-session.test.ts
│               ├── list-sessions.test.ts
│               ├── get-session.test.ts
│               ├── update-session.test.ts
│               ├── archive-session.test.ts
│               ├── delete-session.test.ts
│               └── session-resources.test.ts   # 四个挂载端点合并一个文件(共享夹具多)
├── packages/
│   ├── shared/
│   │   ├── src/
│   │   │   └── session/                        # Session 协议定义
│   │   │       ├── schemas.ts                  # 全部请求/响应 schema: 创建(含 agent 三形态、
│   │   │       │                               #   resources、兼容字段)、更新、列表过滤参数、
│   │   │       │                               #   Session/SessionResource 响应, 及 z.infer 类型
│   │   │       ├── resolve.ts                  # resolveSessionAgent: 版本配置 ⊕ 覆盖 → 最终配置
│   │   │       │                               #   (字段级整体替换; 省略继承 / null 与空数组清空)
│   │   │       └── mount-path.ts               # normalizeMountPath + overlapsAny: 路径消解、
│   │   │                                       #   逃逸检测、长度上限、按路径段的前缀重叠判定
│   │   └── test/session/
│   │       ├── schemas.test.ts                 # 三形态、一期裁剪(initial_events/vault_ids/memory_store
│   │       │                                   #   非空拒绝)、minProperties 等校验用例
│   │       ├── resolve.test.ts                 # 覆盖语义穷举: 省略/null/空数组/整体替换各组合
│   │       └── mount-path.test.ts              # 默认路径、绝对/相对拼接、. / .. 消解、逃逸、
│   │                                           #   长度、前缀重叠(相等/包含/兄弟不重叠)
│   └── db/
│       └── src/
│           └── session/
│               ├── ids.ts                      # newSessionId() / newSessionResourceId()
│               │                               #   (sess_ / sres_ + uuidv7, 复用 ../uuid.ts)
│               └── repo.ts                     # 全部 SQL 的唯一出处(函数清单见下)
```

传输层的全局入口改动只有一处：`routes/v1.ts` 增加 `v1.route("/sessions", sessionRoutes)`。跨模块的存储层补齐：`agent/repo.ts` 补 `findAgentVersion(db, agentId, version)`（点查指定版本行，现有仓储只有「取当前版本」）；`environment/repo.ts` 的按 id 读取若未导出则补 `findEnvironment`；`file/repo.ts` 补 `findFilesByIds`（批量校验挂载引用）。

## 存储层：`repo.ts` 函数清单

```ts
createSession(db, { session, resources })     // 创建: sessions 行 + N 条 session_resources 同一 batch
findSession(db, sessionId)                    // 点查; 获取/更新/归档/删除的共同入口, 查不到返回 null
listSessionsPage(db, filters)                 // 过滤(agent_id/agent_version/statuses/created_at 区间/
                                              //   include_archived) + (created_at, id) keyset 分页
updateSessionRow(db, { sessionId, patch, expectedArchivedAt: null, now })
                                              // 守卫式就地覆盖: WHERE archived_at IS NULL;
                                              //   0 行受影响 → 上层重读区分 404 / 409
archiveSession(db, sessionId, now)            // WHERE archived_at IS NULL AND status != 'running';
                                              //   0 行受影响 → 重读区分 404(不存在) / 409(已归档/running)
deleteSession(db, sessionId)                  // batch: 先删 session_resources 再删 sessions;
                                              //   WHERE status != 'running', 0 行 → 重读区分 404 / 409
insertSessionResource(db, resource)           // 挂载(唯一性冲突由 UNIQUE(session_id, mount_path) 兜底)
listSessionResourcesPage(db, sessionId, { limit, order, cursor })
findSessionResource(db, { sessionId, resourceId })
deleteSessionResource(db, { sessionId, resourceId })
countSessionFileMounts(db, fileId)            // file 模块删除检查用: 该 file 被未归档会话挂载的次数
findSessionIdsByFileId(db, fileId)            // file 模块 list 过滤用(scope_id 真实化)
```

要点：

- **事务边界照旧收敛在 repo 内**。`createSession` 与 `deleteSession` 的多条语句必须放进同一个 D1 batch（隐式事务）；调用方永远拿到完整原子操作。
- **「0 行受影响」的歧义消除交回 service**。`updateSessionRow` / `archiveSession` / `deleteSession` 的守卫条件都可能在「不存在」「已归档」「running」之间产生 0 行，repo 只返回布尔，service 重读一次区分错误码——与 Agent 模块区分 409 / 400 的手法同源，但 Session 的归档是 409 而非幂等成功，重读分支多一条。
- **`agent_config` 的读-改-写在 service 完成**：repo 只负责整行写入，`resolveSessionAgent(currentConfig, { tools, mcp_servers })` 的替换计算是纯函数。

## 协议层：schema 的两处特别处理

**兼容字段 `agent_id`。** GLM 的创建请求 `anyOf: [agent, agent_id]`——`agent` 缺失时接受顶层 `agent_id` 字符串。zod 侧用 `z.union` + `superRefine` 表达「两者至少其一、同时出现时 `agent` 优先」，`.strict()` 仍然生效（两个都缺 → 400）。

**一期裁剪的字段不从 schema 里删除。** `initial_events` / `vault_ids` / `resources[].type` 的 schema 形状与 GLM 完全一致（含上限、枚举），只是 `superRefine` 附加「非空 / 非 `file` 即拒绝」的一期规则。这样 wire 兼容客户端的合法空值（省略、`[]`）原样通过，二期放开时删掉 refine 分支即可，schema 主体不动。

## 传输层：service 的判定链

以最复杂的 `createSession` 为例，判定顺序即 [create-session.md](api/create-session.md) 文档语义的代码化：

1. 解析 `agent` 引用：字符串 / `agent` 对象 / `agent_with_overrides` 三形态归一为 `{id, version?, overrides?}`；读 Agent——不存在 → 404；指定版本不存在 → 400（message 带当前最新版本号）；省略版本 → 钉 `current_version`。
2. `resolveSessionAgent` 得到最终配置，superRefine 校验最终配置的 mcp 映射与 skills 联动；skills 引用存在性查 `skill_versions` → 缺失 400。
3. 读 Environment：不存在 → 404；`state != active` → 400；取归一化 config 作快照。
4. 校验 `resources`：`findFilesByIds` 全部存在（缺失 400）；`normalizeMountPath` 逐条归一化（失败 400）；`overlapsAny` 两两不重叠（重叠 400）；`file` 数 ≤ 500。
5. 生成 `sess_` ID 与 N 个 `sres_` ID，`createSession` 单 batch 落库。
6. serialize 注入固定回显字段（`type` / `vault_ids: []` / `outcome_evaluations: []` / `stats` / `budget: null` / `agent.type` / `agent.multiagent: null`）。

`updateSession` 的判定链：取行（null → 404）→ 已归档 → 409 → `agent.tools/mcp_servers` 存在且 `status != idle` → 409 → 纯函数合并（title 替换、metadata 按键合并、agent_config 内整体替换）→ 无变化检测 → `updateSessionRow` 守卫式写入。`archiveSession`：取行 → null 404 → 已归档 409 → `repo.archiveSession` 0 行时重读分诊（404 / 409 已归档 / 409 running）。

serialize 的一个新职责：`resources` 子对象来自 `session_resources` 的子查询（列表端点批量取，单对象端点点查），不能像 Agent 那样全部从单行拼装；`session.agent` 则直接取 `agent_config` JSON 加两个注入字段。

## 一个请求的完整旅程

以创建会话（`POST /v1/sessions`）为例：

1. `index.ts` 接到请求：request-id 中间件生成 `request_id`，auth 中间件校验 Bearer。
2. 路由经 `routes/v1.ts` 进入 `modules/session/routes.ts`，命中 `handlers/create-session.ts`。
3. handler 用 `SessionCreateRequest` 解析请求体：三形态 `agent`、一期裁剪、上限与枚举在此完成，非法即 400。
4. handler 调 `service.createSession`，按上节判定链执行；跨资源读取全部经由各模块仓储函数。
5. 成功路径：service 返回新行与资源行，`serialize.ts` 转成 API JSON（含注入字段与 `resources` 拼装），handler 以 201 返回。
6. 任何环节抛 `ApiError`，`app.onError` 统一渲染带 `request_id` 的错误信封。

## 测试策略

纯函数单测（`packages/shared/test/session/`，node 环境）：`resolve` 穷举覆盖语义（省略继承、null 与空数组清空、整体替换、最终配置校验的输入）；`mount-path` 穷举路径消解与重叠边界（`..` 逃逸、`/` 结尾、同名兄弟路径、相等路径、1024 字节边界）。

集成测试（`apps/api/test/sessions/`，真实 Workers 运行时 + miniflare D1）重点关注四件事：

- **跨资源前置态**：`helpers.ts` 提供先建 agent / environment / file 的工厂；覆盖引用不存在（404 与 400 的分界）、environment 已归档（400）、file 缺失（400）。
- **会话特有的 409 语义**：重复归档 409（反直觉，必须显式断言，与 agent 归档幂等形成对照）；归档后更新 / 挂载 409。
- **列表行为**：默认排除已归档、`include_archived=true` 包含、`agent_id`+`agent_version` 过滤、`statuses[]` 重复参数、`created_at[gte]` 等区间、`memory_store_id` 400。
- **挂载端到端**：归一化回显（省略 mount_path 得默认路径）、重叠拒绝、500 上限、删除会话后 file 恢复可删（对 file 模块的回归断言）。

## 二期运行时的扩展路径

事件端点（`POST/GET /v1/sessions/:id/events`、`GET …/events/stream`）与状态迁移引入时：

1. `apps/api/src/runtime/` 建目录：`do/session-do.ts`（事件历史 + SSE，实例 id 即 sessionId）与 `workflows/agent-loop.ts`（Agent 循环持久化执行，调 GLM 模型 API 与 Sandbox SDK）；`wrangler.jsonc` 解开 `durable_objects` / `workflows` 绑定注释。运行时属于传输层侧的独立子系统，不进 `modules/session/`，经 service 触发而非被 handler 直连。
2. 协议层补 `packages/shared/src/session/events.ts`（事件 wire schema）；存储层不动——事件历史在 DO，D1 的 `sessions.status` 由运行时经既有 `updateSessionRow` 风格的守卫 UPDATE 迁移（`idle → running → idle`），`usage` 三列由运行时累计。
3. 挂载/资源端点与本文档全部端点零改动；`initial_events` / `x-events-encrypted` 的放开只删 refine 分支。
