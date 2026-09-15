# Session 运行时设计（二期）：事件、流式输出与 Agent 循环

本文是二期运行时的定稿设计：事件模型、SSE 流式输出、Agent 循环执行器与崩溃恢复。一期只做了元数据控制面（[schema.md](schema.md) 的两张表与 [api/](api/) 的十个端点）；二期补齐 GLM 会话工作流的另一半——「先开 SSE 流、再发消息、会话进入 running、结束后回到 idle」。

执行器架构（**Agent 循环跑在 `SESSION_DO` 内部，自管检查点与恢复，不使用 Workflows**）是本文的第一项内容，以决策记录的形式固定下来。

## 0. 决策记录：执行器为什么是 SESSION_DO 自管

原架构（[architecture-diagrams.md](../architecture-diagrams.md) 旧版）计划「每轮循环由 `agent-loop` Workflow 持久化执行」。定稿时推翻，理由按分量排序：

1. **Workflows 的 step 语义与流式传输相抵触。** step 返回值上限 1 MiB 且必然进 Workflow state——要保住真流式，就必须立一条永久纪律「消息体永不穿越 step 边界，step 之间只传 id 与计量」。契约可以守，但它把执行器拓扑焊死在「瘦 step」一种写法上，任何后续功能（工具输出、组上下文、观测）都要先过这道审查。
2. **Workflow state 作为检查点是冗余的。** 事件日志 append-only + 事件 id 去重 + turn 号，已经能重放出「该从哪继续」；Workflow 的核心卖点（持久化程序位置）我们在正确性上并不需要，剩下的价值全是运营性的（托管重试退避、实例观测），而前者是一个十行的 fetch 包装。
3. **平台方的架构投票。** cloudflare/agents 官方框架为长时 Agent 设计的持久执行方案（`experimental/forever.md`，`runFiber()`）落点是 DO 内自建：4 列 SQLite 表 + 同步快照 + 恢复钩子，并且刻意**删除**了旧版的 `maxRetries` 与 12 列状态机——「引擎托管的恢复状态在实践中是负资产，恢复逻辑属于有完整上下文的开发者钩子」。
4. **fire-and-forget 执行的保活问题在 DO 内有原生答案**（alarm 心跳），在 Workflows 里则只能靠 step 重执行硬扛。

依据的平台事实（forever.md 与 Cloudflare 文档）：

- DO 空闲逐出阈值 ~70–140s，**只计入站请求与打开的连接，出站 I/O 不算**——fire-and-forget 的 turn 在等模型流回包时照样可能被判定空闲。
- 代码发布 / 运行时重启每日 1–2 次，强制逐出是**日常**而非异常；恢复路径是正常流程，必须可测试。
- alarm handler 上限 15 分钟——handler 只做毫秒级事务，turn 执行不进 alarm。
- LLM 流中途断掉**无法续传**；恢复只能是重发、取回已存响应或合成继续，三选一。

**可逆性**（对冲不变式）：wire 协议、事件日志 schema、console 消费端都不感知执行器形态。若三期出现真正的 workflow 形状工作（跨天的人审业务流），再单独评估 Workflows；届时本设计的执行器可整体替换而不动协议与存储。

> `wrangler.jsonc` 注释中预留的 `workflows` 绑定已删除；`durable_objects` 绑定保留。

## 1. 组件分工

| 组件 | 职责 |
| --- | --- |
| `SESSION_DO`（每会话一个） | 单写者：状态机（idle/running 门禁）、事件日志、SSE fan-out、turn 执行器、alarm 复用器、崩溃恢复 |
| Sandbox SDK | `agent_toolset_20260601` 七个内置工具的执行环境；skills 挂 `/mnt/skills`，上传文件挂 `/mnt/session/uploads`（只读），产出写 `/mnt/session/outputs` → turn 收尾收割编目为 File 资源（R2 `files/{id}` + D1 `session_outputs`，见 [../files/schema.md](../files/schema.md)「会话产出文件」） |
| D1（`DB`） | 元数据事实源；`sessions.status` 与 usage 三列降级为**投影**（§8），由运行时回写 |
| Cloudflare AI Gateway REST API | 模型服务：`POST /accounts/{id}/ai/v1/chat/completions`（OpenAI chat 格式，流式 + tools），Cloudflare 托管的 `@cf/zai-org/*` 模型；凭据 `CLOUDFLARE_API_TOKEN`（Workers AI Read 权限），`@cf` 请求必带 `cf-aig-gateway-id` 头。同服务的 `/ai/v1/responses` 对 `@cf` 模型支持按模型而定——zai-org 实测不接受 Responses 输入形状（上游 400），故走 chat completions。存量模型 id `glm-5.3` / `glm-5.3-flash` 不变，wire 侧按 `@nano/shared` 的模型目录映射（`agent/models.ts`）；目录外 id 原样透传（动态模型）。已知限制：网关日志对流式请求的 token 成本统计不完整 |
| console `/nano` 代理 | SSE 透传链路已就绪（与 `/glm` 共用） |

## 2. 事件模型

### 2.1 信封与身份

所有事件共用一个信封，载荷字段按 `type` 展开（对应 GLM `ManagedPersistedEvent` 的 `additionalProperties: true`）：

```jsonc
{
  "id": "sevt_01911111-5555-7555-8555-555555555555",  // sevt_ + UUIDv7，单调可排序
  "type": "agent.message",
  "created_at": "2026-09-12T08:00:00.000Z",
  "processed_at": null,   // 排队中的输入事件为 null，消费后回填
  // …载荷由 type 决定
}
```

- **`tool_use_id` 就是事件 id**：`user.tool_confirmation.tool_use_id`、`agent.tool_result.tool_use_id`、`stop_reason.event_ids` 三处全部指向同一个 `sevt_` id（GLM 权限文档语义：确认时填「对应工具调用事件的 ID」），没有独立的工具调用命名空间。
- **不可变约定**：事件 append-only，身份与载荷一经落库不改；唯一例外是 `processed_at`——输入事件在排队期间为 `null`，被消费后回填时间戳（与 GLM「排队中的输入事件可能省略；部分确认/中断事件为 null」对齐）。

### 2.2 stop_reason：把「为什么停下」编码进事件流

`session.status_idle` 事件携带 `stop_reason`，客户端只消费事件流即可完整还原状态机，无需轮询会话状态：

```jsonc
{ "id": "sevt_…", "type": "session.status_idle",
  "stop_reason": { "type": "requires_action", "event_ids": ["sevt_tool_…"] } }
```

`type` 取值：`end_turn`（正常完成）、`requires_action`（等待工具审批，`event_ids` 列出待审批事件）、`interrupted`（被 `user.interrupt` 打断）。

### 2.3 二期事件子集（35 选 14）

wire 枚举保留 GLM 全集（`shared` 的 `EventType` 已是全集），二期运行时**产生**以下 14 个；其余类型协议在、不发。

| 层 | 二期产生 | 延后与理由 |
| --- | --- | --- |
| `user.*` | `message`、`interrupt`、`tool_confirmation` | `custom_tool_result` / `tool_result` / `define_outcome` 随对应能力延后 |
| `agent.*` | `thinking`、`message`、`tool_use`、`tool_result` | `mcp_*`（无 MCP）、`custom_tool_use`（无自定义工具）、`thread_*`（见下）、`thread_context_compacted`（三期 compaction） |
| `session.*` | `status_running`、`status_idle`、`error`、`usage`、`updated`、`deleted` | `thread_*` 内部化（一 session 一 thread，不外发）；`status_rescheduled`（沙箱休眠唤醒，三期）、`status_terminated`（环境归档准入联动，三期） |
| 其他 | `system.message`（恢复通知等平台消息） | `span.*` 观测层，协议最便宜，M4 后可随时加 |

`session.updated` 由控制面（更新端点）而非执行器产生；`session.deleted` 在删除流程中**先广播给订阅者、再清空 DO 存储**。

### 2.4 事件存储（DO SQLite，不进 D1）

事件端点全部以会话为作用域，无跨会话查询需求；「删除会话即永久删除事件历史」＝删 DO 全部存储。表：

```sql
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 单写者下的全序:分页与"之后"判定
  id           TEXT NOT NULL UNIQUE,               -- sevt_ + UUIDv7:幂等去重键
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,                      -- 完整事件 JSON(含 id/type/created_at/processed_at)
  created_at   INTEGER NOT NULL,                   -- ms
  processed_at INTEGER                             -- NULL = 未消费(积压输入);产出事件即处理
);
CREATE INDEX idx_events_type ON events(type, seq);
CREATE INDEX idx_events_created ON events(created_at, seq);
```

- `list-events`（`GET /v1/sessions/:id/events`）的 `types[]` / `created_at[gt/gte/lt/lte]` 过滤、`order`、`limit ≤ 100`、opaque `page` 游标全部走 `(type?, seq)` keyset；游标 payload 带类型前缀防与其他列表端点混用（仓库既有约定）。
- **delta 不落库**（§7）：事件表里只有终事件，没有增量。
- `append()` 是唯一写入口，按 id 去重（重复 append 返回既有行）——这是执行器重试不产生重复事件的兜底。

## 3. 两级检查点

| 级别 | 载体 | 内容 | 可见性 |
| --- | --- | --- | --- |
| 粗粒度（权威） | 事件日志 | 已确定发生的全部事实（终事件） | 客户端可见，wire 契约 |
| 细粒度（实现细节） | `session_turns.snapshot`（§4.1） | `{ call_id, iteration, partial_text, provider_hints }` | 内部，客户端不可见 |

日志覆盖 **turn 之间**的位置恢复，覆盖不了**流中途**的部分生成物——delta 只在流上存在，中途逐出时部分文本只活在 snapshot 里。因此模型流式期间按节奏同步写 snapshot（每 ~64 chunk 或 ~500ms，`ctx.storage.sql` 同步执行、无 await 间隙、整体替换），恢复策略（§6）依赖它。

## 4. turn 执行器

### 4.1 `session_turns` 表

```sql
CREATE TABLE session_turns (
  turn_id    TEXT PRIMARY KEY,   -- trn_ + UUIDv7，触发侧生成
  iteration  INTEGER NOT NULL,   -- 当前模型调用序号（恢复用）
  snapshot   TEXT NOT NULL,      -- §3 细粒度检查点，纯内部状态
  created_at INTEGER NOT NULL
);
```

仿 fibers 的 name/snapshot 分离：**身份编码在列，snapshot 只放循环内部状态**。**行存在 = turn 在跑**；正常结束、挂起、致命错误都删行。行删除即挂起（§4.3），是「会话无限期等待审批」的零成本实现。

### 4.2 turn 生命周期

```
POST /events (user.message)
  → append(user.message, processed_at 回填)
  → idle→running：append(session.status_running) + D1 status 投影回写
  → INSERT session_turns → keepAlive() → fire-and-forget runTurn()
  → HTTP 响应立即返回（持久化事件数组）

runTurn 循环：
  1. 从事件日志组装 messages（system + agent_config 快照 + 历史，含未消费输入）
  2. 流式调 GLM（确定性 call_id = turn_id:iteration）
     · delta → 批量（时间窗 50–100ms 或换行）推给 SSE 订阅者，不落库
     · 按 §3 节奏 stash(snapshot)
     · 终结 → append(agent.thinking / agent.message)      ← 消息体唯一落库点
  3. 解析 tool_use：
     · always_allow → 沙箱执行 → append(agent.tool_result) → 回到 1
     · always_ask   → append(agent.tool_use)
                    → append(session.status_idle{requires_action, event_ids})
                    → DELETE session_turns + 释放 keepAlive + D1 回写 idle   ← 挂起
  4. 无 tool_use → append(session.usage)
     → append(session.status_idle{end_turn}) → 删行 → usage 回写 D1
```

终事件的 id 在发起模型调用**前**预生成（进 snapshot），append 按 id 去重——同一轮的重试不会产生两条 `agent.message`。

### 4.3 挂起（requires_action）＝行删除

等待审批时什么都没在跑：没有心跳、没有计费、没有实例；待审批集合（`tool_use_id → {result?}`）是 DO 里的持久状态。`user.tool_confirmation` 到达且 pending 集合清空 → idle→running → 新 turn 行 → `runTurn`。`deny` 不执行工具，合成一条含 `deny_message` 的 `agent.tool_result` 喂回模型。

### 4.4 打断与 running 中追加消息

- **`user.interrupt`**：DO 置中断标志；`runTurn` 在流读取循环内逐 chunk 检查 → `AbortController` 掐断模型请求 → **不落半截终事件** → `append(session.status_idle{interrupted})` → 删行。已在途的沙箱工具调用执行完再停（杀死 bash 的副作用比重跑更糟），其 `tool_result` 照常落库。
- **running 时追加 `user.message`**：只落日志、不打断当前请求；下一次迭代组装上下文时自然带上。turn 收尾前检查「是否积压了未消费输入」，有则本 turn 内继续消费——消除「新输入恰在收尾窗口到达」的漏消息竞态。

### 4.5 沙箱生命周期（M2 决策先行定稿：按需冷启 + 平台空闲回收）

**决策：每会话一个沙箱（实例 id = sessionId），按需冷启，不启用 `keepAlive`，空闲回收交给平台默认的 `sleepAfter`（10 分钟）。**

依据的平台事实（Cloudflare Sandbox SDK 文档，2026-09）：

- 生命周期 created（惰性，首次引用即建）→ running → sleeping → destroyed；`sleepAfter` 默认 10m，到期容器停机且**全部状态清零**（文件删除、进程终止、shell 状态重置），下次请求隐式拉起全新容器；`destroy()` 永久删除一切。
- `keepAlive: true` 是唯一的「常驻」开关：每 30s 心跳防逐出、永不自动睡眠——但容器持续计费、占用账号配额，且必须显式 `setKeepAlive(false)` / `destroy()` 收尾，否则泄漏。
- 启动超时上限：实例供给 30s、端口就绪 90s（高峰期的最坏情形）；计费跟随容器活跃时长，官方文档给出的降本建议就是调低 `sleepAfter`。
- Directory backups（R2 支撑）提供目录级备份 / 还原；还原后的文件同样不跨 sleep 存活——醒后须再次还原。
- 首次请求钉住地理位置，后续请求路由到同一位置。

**为什么「会话级常驻」被否**（按分量排序）：

1. **常驻买不到持久性——这是平台事实，不是配置项。** sleep 即状态清零，`keepAlive` 只是「不被平台睡眠」；DO 逐出、代码发布、运行时重启照样停容器，醒来仍是全新环境。也就是说无论常驻与否，nano 都必须自建工作区再物化；常驻剩下的唯一价值是免冷启延迟，代价却是会话全程计费 + 配额占用 + 手动生命周期管理。
2. **默认 `sleepAfter` 恰好免费提供「会话级半常驻」。** 10 分钟窗口内连续 turn 复用同一容器（文件、工作目录天然存活），活跃对话几乎不冷启；对话停了 10 分钟，容器自动停机停止计费——这正是「快与省」的交点。
3. **冷启延迟有天然掩体。** turn 启动时模型调用（首响应秒级）与沙箱预热可并行发起；模型决定调用工具时容器通常已就绪。最坏 30s 供给超时只出现在平台高峰，接受为工具延迟的一部分。

**推论：**

- **工作区物化协议（M2 实现契约）**：每次冷启后由 DO 物化三类内容——挂载文件（R2 → `/mnt/session/uploads`，只读）、skills（`/mnt/skills`）、outputs 回填（D1 `session_outputs` 映射 → R2 `files/{fileId}` → `/mnt/session/outputs`）。**outputs 在每个 turn 收尾时收割编目为 File 资源**（差集同步、以沙箱现状为准，协议定稿见 [../files/schema.md](../files/schema.md)「会话产出文件」）：sleep 即清零的平台事实要求产出必须及时离开沙箱，「会话产出文件」的编目语义才成立。`/workspace` 的其余临时状态视为易失，不承诺跨 sleep 存活；M2 实测若需更强语义，用 Directory backups 补（醒后显式再还原）。
- **`rescheduled` 维持三期预留，M2 不产生。** GLM 的 rescheduling 是「平台正在重新调度会话的沙箱（恢复或迁移），随后自动回到执行」——一个会话级、独立于 turn 的可观测中间态。nano 的冷启永远**嵌在活跃 turn 内**（工具调用阻塞等它），不存在「会话在 turn 之外等沙箱」的时刻；强行外发 `status_rescheduled` 只是 turn 中途的 wire 噪声。`statuses[]` 过滤与 wire 枚举照旧保留（同一期预留的口径，同 `terminated`）。三期若出现平台主动维护（预热队列、跨区迁移）产生真正的「turn 外等沙箱」状态，再引入。
- **删除 / 归档联动**：删除会话必须 `destroy()`（显式清掉容器与全部状态，与 DO 的 wipe 并行）；归档后不再接受新 turn，沙箱随 `sleepAfter` 自然消亡，归档处理中顺手 destroy（归档即终态，不再有执行）。
- **可逆性**：wire、事件日志、console 消费端均不感知沙箱生命周期；三期若需特定会话常驻（如 console 实时预览），对该会话单独开 `keepAlive` 即可，协议零改动。

## 5. alarm 复用器与保活

**一个 DO 只有一个 alarm 槽**，从第一天就按多路复用器设计（earliest-deadline-wins），否则三期返工：

- **心跳**：`keepAlive()` 引用计数，默认 30s（测试可调 2s）。SSE 订阅是入站连接、天然保活，不需要心跳；**fire-and-forget 的 turn 执行**才是心跳服务的对象（出站 I/O 不算平台空闲判定的活动）。心跳不进任何业务表，对调度接口不可见。
- **恢复巡检**：发现「有 `session_turns` 行但内存无活跃 turn」→ 进入 §6。
- **（三期）定时任务**：Deployment 调度等，届时挂进同一复用器。

alarm handler 只做毫秒级事务（续期、巡检触发），turn 执行永远不进 alarm。

## 6. 崩溃恢复（onTurnRecovered）

两类逐出：**空闲逐出**（keepAlive 防住；仍发生即配置错误，巡检兜底）与**强制逐出**（发布/崩溃，日常）。`onStart()` 与 alarm 巡检发现孤儿 turn 行后，恢复钩子拿 snapshot 决策：

1. **重发**（默认）：从日志重组上下文、同 `call_id` 重新调用；终事件 id 沿用 snapshot 里的预生成值，append 去重防重复。代价：token 重复计费、用户看到流重启。
2. **部分落盘 + 合成继续**（备选）：`snapshot.partial_text` 追加为一条 `agent.message`，再合成「继续」请求。是否可行取决于 GLM 是否支持 assistant prefill / 续写语义，**M1 实测后定**。

恢复动作本身外发一条 `system.message`（客户端可见「发生了恢复」）。沙箱工具的幂等：snapshot 记录执行进度，已落 `tool_result` 的工具不重跑；若逐出发生在「执行完成与落库之间」，接受重跑一次（副作用风险与重发模型请求同级，物理下限）。**不做自动重试**：恢复策略写死在钩子里，不引入引擎托管的重试状态机（同 forever.md 删除 `maxRetries` 的理由）。

## 7. SSE 流式输出

端点 `GET /v1/sessions/:id/events/stream`：handler 经 DO stub 取 `ReadableStream` 透传，认证在 worker 边缘照旧；会话存在性先查 D1（404 门禁）。

- **帧**：`data: <事件 JSON>\n\n`（与持久化事件同构），不用 SSE `event:` 字段；心跳 `: ping` 注释帧每 15s。
- **只推连接后的新事件，不回放**。重连协议照抄 GLM：先 `GET /events`（`created_at[gt]` 或游标）补历史，再重连流，按事件 id 去重。基于 `Last-Event-ID` 的回放留作后续增强（DO 有 `seq`，做得到）。
- **delta 帧**（nano 定义，不持久化、不进 `EventType` 枚举）：

```
data: {"type":"agent.message.delta","event_id":"sevt_…","seq":3,"delta":{"text":"…"}}
data: {"type":"agent.thinking.delta","event_id":"sevt_…","seq":4,"delta":{"text":"…"}}
data: {"type":"agent.message","id":"sevt_…","content":[{"type":"text","text":"…"}], …}
```

独立 `.delta` 类型 + `event_id` 引用终事件；delta 在前、终事件在后，DO 单写者串行化保证顺序；断线丢 delta 无害（终事件补全）。`event_deltas[]` 查询参数过滤订阅的 delta 种类（仅 `agent.message` / `agent.thinking` 两类存在）；未订阅的客户端只见终事件，流行为自洽。
- **fan-out 与背压**：`append()` 落库后依次写各订阅者流；慢消费者直接断开（补历史 + 重连自愈）；每 DO 订阅上限 16。

## 8. 与 D1 及既有模块的边界

- **`sessions.status` 从事实降级为投影**：状态机事实源是 DO；每次迁移即时回写 D1，usage 三列在 turn 终局回写（守卫式 UPDATE，`packages/db` 既有风格）。列表 `statuses[]` 过滤仍查 D1，容忍秒级陈旧。
- `GET /v1/sessions/:id` 的 `status` / `usage` 读 D1 投影；`resources` / `agent` / `environment_snapshot` 维持一期语义不动。
- **`environment_snapshot`** 由执行器在首次工具调用时消费（供给沙箱），不回读 `environments` 表（创建即冻结语义）。
- **事件端点路由**：`modules/session` handler → service → `env.SESSION_DO.idFromName(sessionId)` 的 stub；404 门禁先查 D1 行存在性。运行时代码在 `apps/api/src/runtime/do/`，不进 `modules/session/`（分层见 [structure.md](structure.md)）。
- **删除 / 归档协同**：删除 = 广播 `session.deleted` → 清空 DO 存储 → 断开订阅 → 删 D1 行（含级联）；归档门禁「非 running」由 DO 状态机裁决（一期 409 分支直接生效）。
- 一期裁剪放开：`initial_events` 非空拒绝分支删除（创建时走同一条 append → 触发链路）；`x-events-encrypted` 仍延后（涉及密钥管理，单列设计）。

## 9. 测试策略

- **纯函数**（`@nano/shared`，node 单测）：事件信封 / 去重 / 游标编码；事件日志 → messages 的上下文组装（含 compaction 预留参数位）；恢复策略选择的决策逻辑。
- **DO 集成**（vitest-pool-workers）：append/list 过滤分页、SSE 帧顺序与只推新事件、delta→终事件顺序、挂起（行删除）与确认恢复、interrupt、running 追加消息消费、订阅上限与慢消费者断开。
- **崩溃恢复 E2E**（脚本级，仿 agents SDK 的 SIGKILL 测试）：wrangler dev 起服务 → 触发 turn → `kill -9` → 同一 `persistTo` 目录重启 → 断言三件事——孤儿 turn 行被巡检恢复、终事件无重复（预生成 id 去重兜底）、`system.message` 已外发。

## 10. 里程碑切分（概览）

细节见 [runtime-work-plan.md](runtime-work-plan.md)（同既有里程碑纪律；M0 已落地），骨架：

| 里程碑 | 交付 |
| --- | --- |
| M0 DO 骨架 | `SESSION_DO` 建类 + 绑定；事件 append / list / SSE 端点 + 状态机门禁打通（可用假事件手测，无循环） |
| M1 对话闭环 | `runTurn` 无工具：模型流 → delta → 终事件 → usage；keepAlive、snapshot、崩溃恢复、`system.message` |
| M2 沙箱工具 | 七个内置工具 + 挂载文件 / skills 供给 + `tool_use` / `tool_result`；`environment_snapshot` 消费 |
| M3 确认与打断 | `always_ask` 挂起 / 恢复、`user.interrupt`、running 追加消息 |
| M4 收尾 | usage / stats 回写、`session.error` 路径、console 会话详情页接流、SIGKILL E2E |

## 11. 开放问题

1. **沙箱生命周期**：已定（M2 决策先行）——按需冷启 + 平台默认 `sleepAfter`（10m）空闲回收，不启用 `keepAlive`；`rescheduled` 维持三期预留（冷启嵌在活跃 turn 内，无独立可观测的会话级重调度时刻）。决策记录与平台事实见 §4.5。
2. **GLM 续写支持**：assistant prefill / 取回已存响应是否可用，决定恢复策略 2 是否可行（M1 状态：未实测——需真实凭据；恢复已按策略 1 重发落地，策略 2 待实测后定）。
3. **`x-events-encrypted` / `x-checkpoint`**：密钥管理单独设计，二期不做。

## 附：事件侧与 GLM 的差异

| 项 | GLM | nano |
| --- | --- | --- |
| 路径前缀 / 协议头 | `/agent/managed/v1/…` + `zai-version` / `zai-beta` | `/v1/…`，无协议头（同既有约定） |
| 事件载荷 shape | 正文页缺失，仅信封在 OpenAPI | nano 自定（Anthropic 风格 content blocks），信封与枚举对齐 OpenAPI |
| delta 帧 | `event_deltas[]` 参数存在，帧形态未文档化 | `.delta` 独立类型 + `event_id`（§7） |
| 重连协议 | list 补历史 + 按 id 去重 | 照抄 |
| `span.*` / `thread_*` / `mcp_*` | 产生 | 二期不产生（§2.3） |
