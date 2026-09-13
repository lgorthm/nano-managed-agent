# Session 运行时实现计划（二期）

本计划依据 [runtime.md](runtime.md) 的定稿设计，把二期运行时拆成五个里程碑：M0 骨架、M1 对话闭环、M2 沙箱工具、M3 确认与打断、M4 收尾。一期（[work-plan.md](work-plan.md)）交付了元数据控制面；二期补齐「先开 SSE 流、再发消息、会话进入 running、结束后回到 idle」的执行面。M0 已随事件三端点落地，任务清单如实勾选；M1 起为本计划的待办。

## 总体思路

**执行器整体替换，宿主接口不动。** M0 的 `runTurn` 是 null-turn（消费输入 → usage 全零 → end_turn），只负责打通事件链路、状态机门禁与 SSE；M1 在 `turn-executor.ts` 内插入真实模型循环，`SessionDo` 与 `TurnHost` 接口不变。后续里程碑沿用同一手法：每个里程碑只动执行器与其新增的宿主能力，wire 协议与事件 schema 零改动。

**顺序线性，风险递进。** M1 立模型调用与崩溃恢复（最难、最依赖上游实测）；M2 在循环里插入工具执行；M3 在 tool_use 处挂确认分支、补 interrupt 完整语义；M4 横切收尾。M3 的 `user.interrupt` 只依赖 M1 的流循环，可与 M2 并行推进。

**六条不变式要靠测试守住**（实现时最容易走样、code review 最容易被既有模块先例带偏的行为）：

1. 事件 append-only，终事件 id 预生成 + `INSERT OR IGNORE` 去重——执行器重试不产生重复事件；
2. 消息体唯一落库点是终事件，delta 只在流上存在、不落库、不进 `EventType` 枚举；
3. 挂起（requires_action）＝ turn 行删除——等待审批期间无心跳、无计费、无实例；
4. D1 的 `status` / `usage` 是投影，事实源在 DO，回写失败只记日志不阻塞；
5. 恢复路径是正常流程（强制逐出每日 1–2 次），必须可测试；
6. alarm handler 只做毫秒级事务，turn 执行永不进 alarm。

**测试金字塔沿用 §9**：协议纯函数 node 单测 → DO 集成（vitest-pool-workers，mock 模型上游）→ 脚本级 E2E（SIGKILL 恢复，M4）。沙箱依赖容器进不了 vitest，工具执行以接口注入隔离（M2）。

## 里程碑总览

| 里程碑 | 交付能力 | 对应设计 | 规模 | 状态 |
| --- | --- | --- | --- | --- |
| M0 DO 骨架 | `SESSION_DO` + 事件三端点 + 状态机门禁（null-turn） | runtime.md §2/§5/§7/§8，api/ 三份事件文档 | 大 | 完成 |
| M1 对话闭环 | 真实模型流 → delta → 终事件 → usage；两级检查点与崩溃恢复 | runtime.md §3/§4/§6 | 大 | 待开工 |
| M2 沙箱工具 | 七个内置工具执行 + 挂载 / skills 供给 + tool_use / tool_result | runtime.md §1/§4 | 大 | 待开工 |
| M3 确认与打断 | always_ask 挂起 / 恢复、user.interrupt、running 追加消息 | runtime.md §4.3/§4.4 | 中 | 待开工 |
| M4 收尾 | session.error 路径、stats 投影定稿、console 接流、SIGKILL E2E | runtime.md §8/§9 | 中 | 待开工 |

依赖关系：

```
M0 → M1 → M2 → M3 → M4
        └ interrupt 子项只依赖 M1 的流循环，可与 M2 并行
```

## 通用工作约定

沿用一期计划（[work-plan.md](work-plan.md)）的 DoD、提交粒度与测试先行纪律，不再重复原文；二期补充四条运行时专属约定：

- **DoD 补充**：除 `pnpm typecheck` / `pnpm test` 全绿与接口文档逐条核对外，改动 DO 行为的里程碑必须在 `pnpm dev` 下 curl 冒烟（M1 起冒烟需真实 GLM 凭据，见各里程碑）。
- **DO 错误约定**：可预期错误以 `DoResult` 结果对象返回、不抛异常；DO 内一切 fire-and-forget promise 必须 `.catch`——测试基线把 DO 未捕获异常记为 unhandled 失败。
- **单写者与 RPC 序列化**：事件唯一写入口是 `SessionDo.appendEvent`；`modules/session` 经 stub 调 RPC、不触 DO 存储；载荷跨 DO RPC 一律 JSON 字符串（递归 JSON 值不赌结构化克隆）。
- **文档同步**：端点行为变化同步改 `docs/session/api/` 对应文档与 README 差异表；开放问题（runtime.md §11）的决策结论回写 runtime.md。

---

## M0 DO 骨架（已落地）

代码与测试已完成且全量通过（38 个测试文件、309 例），已按 shared → db → api 三笔提交落地。清单如实记录如下。

**协议层（`@nano/shared`）：**

- [x] 新建 `packages/shared/src/session/events.ts`：`EVENT_TYPES` 全集（35 项，枚举永不收窄）与 `PRODUCED_EVENT_TYPES` 二期子集（14 项）；`StopReason`；Anthropic 风格 content blocks（text / image / document）；三种输入事件 schema（`user.message` / `user.interrupt` / `user.tool_confirmation`，`deny_message` 仅 deny 可带）与 `SendEventsRequestSchema`（1–10 条）；`InitialUserMessageEventSchema`（创建 `initial_events` 用，不允许 document 块）；`PersistedEventJson` 信封（`processed_at` 是唯一可变字段）；`DeltaFrame` 与 `DELTA_EVENT_TYPES`；`EventListFilters`（时间边界 epoch 毫秒）与分页常量（默认 / 上限 100、默认正序）。
- [x] 单测 `packages/shared/test/session/events.test.ts`。

**运行时（`apps/api/src/runtime/`）：**

- [x] `do/session-do.ts`：`SessionDo extends DurableObject`——SQLite 三表（`events` / `session_turns` / `session_state`）构造时幂等建；`appendEvent` 以 `INSERT OR IGNORE` 按 id 去重、落库后广播；`markProcessed` 回填唯一可变字段；SSE 订阅（上限 16、连接即推一帧 `: ping`、心跳 15s、写失败剔除慢消费者）；`emitDelta` 按 `event_deltas[]` 订阅过滤；`appendControlEvent`（session.updated）；`wipe`（广播 session.deleted → 断开订阅 → `deleteAll` → 重建空表）；turn 生命周期（`startTurn`：idle→running + status_running + 插 turn 行 + keepAlive + fire-and-forget；`finishTurn`：删行幂等、status_idle(stop_reason)、D1 回写、end_turn 后仍有积压输入立即续跑）；alarm 复用器（活跃 turn 续期心跳，否则孤儿巡检）；M0 恢复简化为「system.message + interrupted 收尾」。
- [x] `do/turn-executor.ts`：`TurnHost` 宿主接口 + null-turn 实现（消费输入 → 检查 deleted / interrupted → usage 全零 → end_turn）。
- [x] `ids.ts`（`sevt_` / `trn_` + UUIDv7）与 `session-do-stub.ts`（`idFromName(sessionId)` 取 stub + `unwrapDoResult` 错误翻译）。
- [x] `wrangler.jsonc` 解开 `durable_objects` 绑定与 `new_sqlite_classes` 迁移（`workflows` 绑定按 §0 决策删除）；`index.ts` 导出 `SessionDo`；`pnpm types` 重生成。

**传输层（`modules/session` 与跨端点联动）：**

- [x] 三个 handler 与路由：`send-events`（body 校验 1–10 条，200 返回持久化输入事件）、`list-events`（`types` / `types[]` 兼容重复参数与逗号分隔；`created_at[gt/gte/lt/lte]` RFC 3339 解析，新增 `lib/rfc3339.ts`；游标 kind `session-events`；默认 100 正序）、`stream-events`（`event_deltas[]` ≤ 100 去重校验；IdentityTransformStream 中介管道吸收客户端断开的取消）。
- [x] `service.ts`：`sendEvents` / `listEvents` / `streamEvents`（404 门禁先查 D1，已归档 409）；创建接口放开 `initial_events`（走同一 append → 触发链路，DO 失败让创建失败、不留半态）；更新接口配置实际变更时外发 `session.updated`（失败只记日志）；删除接口先广播 `session.deleted` → `wipe` → 删 D1 行。
- [x] `packages/db`：`updateSessionRuntimeState`（status 迁移 + usage 三列累计的守卫 UPDATE，DO 投影回写用）。

**测试：**

- [x] `apps/api/test/sessions/session-events.test.ts` 15 例四组：发送与 null-turn 生命周期（轮询终局，事件序 user.message → status_running → session.usage → status_idle{end_turn}、`processed_at` 回填、D1 投影回 idle；多消息按序落库；interrupt 单发不触发 turn；tool_confirmation 无待审批 400；请求校验与 401；404 / 已归档 409）、检索（types / created_at 边界 / order / 游标 / 非法参数）、SSE（只推新事件不回放、ping、event_deltas 非法 400）、联动（session.updated 实际变更才外发、删除后 DO 存储清空）。
- [x] `create-session.test.ts` 补 `initial_events` 用例；`helpers.ts` 补 `sendEvents` / `listEvents` / `openEventStream` / `pollForEvent` 等夹具。
- [x] 全量 `pnpm typecheck` / `pnpm test` 全绿。

**验收：**

- [x] `pnpm dev` 起服务，对照三份事件文档 curl 冒烟通过：带 `initial_events` 创建（201，事件序 user.message → status_running → session.usage → status_idle{end_turn}）；先开 SSE 流再发消息（首帧 `: ping`，随后按序推送四个事件，id 与 POST 响应一致，`event_deltas[]` 合法通过）；`types` 过滤与 `created_at[gte]` 边界、终态 D1 投影 `idle`、不存在会话 404。
- [x] 提交落地（`feat(shared)` 事件协议 → `feat(db)` 投影回写 → `feat(api)` DO 与三端点，文档随 api 提交）。

---

## M1 对话闭环 — 真实模型调用（无工具）

null-turn 整体替换为真实循环；交付「发一条 user.message，收到 thinking / message 的 delta 与终事件、真实 usage」。

**协议层（纯函数先行）：**

- [ ] shared 新建上下文组装纯函数（事件数组 + 最终配置 → GLM chat completions `messages`）：system 拼装（agent_config 快照的 system prompt）；历史事件映射（user.message → user 轮，agent.thinking / agent.message → assistant 轮；M2 的 tool_use / tool_result 映射与三期 compaction 先留参数位）。
- [ ] 单测：system 拼装、user / assistant 交替、多轮、未消费输入包含、载荷边界穷举。

**模型客户端：**

- [ ] `runtime/` 新建 GLM chat completions 流式客户端：fetch + SSE 解析，`AbortController` 可掐断；凭据与上游地址经 env 注入（新增 secret，命名对齐 console 侧 GLM 代理约定；`.dev.vars.example` 同步）——集成测试指向 mock 上游，真实 key 只用于冒烟。
- [ ] 带退避的 fetch 包装（§0 决策记录的「十行包装」）：仅连接类错误重试，流已建立不重试。

**执行器真实化（`turn-executor.ts` 整体替换，`TurnHost` 仅增能力）：**

- [ ] 循环迭代：组装 messages（含未消费输入，消费即回填）→ 预生成终事件 id（进 snapshot）→ 流式调用（确定性 `call_id = turn_id:iteration`）。
- [ ] delta 缓冲：时间窗 50–100ms 或换行批量 → `emitDelta`；未订阅 delta 的连接只见终事件。
- [ ] snapshot 节奏落盘（§3）：每 ~64 chunk 或 ~500ms，`ctx.storage.sql` 同步执行、无 await 间隙、整体替换（iteration / partial_text / 预生成 id / call_id）。
- [ ] 流终结 → `appendProducedEvent`（agent.thinking / agent.message，用预生成 id）→ 无 tool_use（M1 不向上游传 tools）→ `session.usage`（上游 usage）→ `finishTurn(end_turn)`；usage 三列与 stats 计时回写 D1。
- [ ] keepAlive 间隔可注入（默认 30s、测试 2s，§5）——恢复类用例要能等到 alarm 巡检。

**崩溃恢复（§6）：**

- [ ] `onStart` 与 alarm 巡检共用恢复入口，替换 M0 的简化分支：策略 1 重发（从日志重组上下文、同 call_id、终事件 id 沿用 snapshot，append 去重兜底）。
- [ ] 实测 GLM assistant prefill / 取回已存响应（开放问题 2）：结论回写 runtime.md §11，决定策略 2（部分落盘 + 合成继续）是否实现。
- [ ] 恢复动作外发 `system.message`。

**测试与验收：**

- [ ] DO 集成（mock 上游返回受控 SSE）：事件序 status_running → thinking / message → usage → idle{end_turn}；delta 帧先于终事件且 `event_id` 一致；usage 回写 D1；多轮上下文组装。
- [ ] 恢复集成：构造孤儿 turn 行 + snapshot → 触发巡检 → 断言终事件无重复 + system.message 已外发。
- [ ] curl 冒烟（真实凭据）：一轮真实对话，肉眼比对事件流与 SSE。

---

## M2 沙箱工具 — tool_use / tool_result

**决策先行（开放问题 1）：**

- [ ] 沙箱生命周期定稿：倾向按需冷启 + 空闲回收；若引入休眠唤醒，`status_rescheduled` 一并引入（wire 枚举已在全集）。结论回写 §11。

**沙箱接入：**

- [ ] Sandbox SDK 接入：`agent_toolset_20260601` 七个内置工具的执行环境；skills 挂 `/mnt/skills`；挂载文件 `/mnt/session/uploads` 只读；产出写 `/mnt/session/outputs` → R2（README 架构表的「会话产出文件」二期项）。
- [ ] `environment_snapshot` 消费：首次工具调用时供给沙箱，不回读 `environments` 表（创建即冻结语义）。
- [ ] 工具执行层接口化（`TurnHost` 先例）：沙箱依赖容器进不了 vitest，单测 / 集成以 fake 执行器注入，真实沙箱走 curl 冒烟与脚本。

**循环插入工具执行：**

- [ ] 向上游传 tools（agent_config.tools → chat completions tool 定义）；解析 tool_use → always_allow → 沙箱执行 → `agent.tool_use` + `agent.tool_result` 落库 → 回到模型迭代；上下文组装补 tool_use / tool_result 映射。always_ask 的挂起分支属 M3，本里程碑集成测试用 always_allow 配置。
- [ ] 工具幂等（§6）：snapshot 记录执行进度，已落 `tool_result` 的工具不重跑；「执行完成与落库之间」逐出接受重跑一次（物理下限）。

**测试与验收：**

- [ ] mock 上游带 tool_use 的流 → fake 执行器 → 断言事件序列与迭代次数（usage 跨迭代累计）；`tool_result.tool_use_id` 关联正确；上下文组装单测补 tool 消息映射。
- [ ] 冒烟：真实沙箱执行一次 bash 工具，产物落 R2 可读。

---

## M3 确认与打断

**always_ask 挂起 / 恢复（§4.3）：**

- [ ] 循环遇 always_ask 工具：`appendProducedEvent(agent.tool_use)` → `finishTurn(requires_action, event_ids)` → 行删除即挂起（释放 keepAlive、D1 回写 idle）。
- [ ] 待审批集合持久化（tool_use_id → 状态）；`user.tool_confirmation` 校验待审批项（放开 M0 的恒 400 分支）：allow 且集合清空 → idle→running 新 turn；deny → 不执行工具，合成含 `deny_message` 的 `agent.tool_result` 喂回模型。
- [ ] 部分确认 / 中断确认的 `processed_at` 语义（null）对照 GLM 权限文档核对。

**user.interrupt 完整语义（§4.4）：**

- [ ] 流读取循环逐 chunk 检查中断标志 → `AbortController` 掐断模型请求 → 不落半截终事件 → `status_idle{interrupted}` → 删行；已在途的沙箱工具执行完再停（杀死 bash 的副作用比重跑更糟），其 `tool_result` 照常落库。

**running 中追加消息（§4.4）：**

- [ ] 只落日志不打断当前请求；下一次迭代组装上下文自然带上；turn 收尾前检查积压输入、有则本 turn 内继续消费——在 M0 的 end_turn 续跑兜底之上补迭代级检查，消除收尾窗口竞态。

**测试与验收：**

- [ ] 挂起 → 确认 → 恢复全链路；deny 路径的合成 tool_result；确认不存在的 tool_use_id 400；interrupt 在流中途（SSE 断言无半截终事件、在途工具的 tool_result 照常落库）；running 追加消息在下一迭代被消费。
- [ ] curl 冒烟对照 send-events / subscribe-events 文档更新后的行为描述。

---

## M4 收尾

- [ ] `session.error` 路径细化：上游 4xx / 5xx / 超时 / 断流分类进载荷；M0 的笼统 turnFailed 分支按错误类型分诊（连接类可重试走退避，不可重试直接 error 收尾回 idle）。
- [ ] usage / stats 投影定稿：turn 终局 usage 三列累计、`stats`（active_seconds / duration_seconds）计时口径核对；获取 / 列表端点回读一致性验收。
- [ ] console 会话详情页接流（`/nano` 代理的 SSE 透传已就绪）：list 补历史 + stream 订阅 + 按 id 去重的重连协议；interrupt 与工具审批的操作入口。
- [ ] SIGKILL E2E（§9，脚本级、不进 vitest）：`wrangler dev` 指定 `persistTo` 目录 → 触发 turn → `kill -9` → 同目录重启 → 断言孤儿 turn 被巡检恢复、终事件无重复、`system.message` 已外发。
- [ ] 可选增强：SSE `Last-Event-ID` 回放（§7 留作后续，DO 有 seq 可做）。
- [ ] 全量验收：全量 `pnpm test` / `pnpm typecheck`；curl 走完整生命周期（创建带 initial_events → 对话 → 工具 → 审批 → interrupt → 归档 → 删除）；开放问题状态回写 runtime.md §11；`x-events-encrypted` 维持单独设计、二期不做。

---

## 风险与注意事项

- **fire-and-forget 的测试时序**：turn 异步完成，测试轮询终局事件（`pollForEvent`），禁止 sleep 固定时长；恢复类用例依赖 keepAlive 间隔可注入（M1 任务）。
- **测试基线把 DO 未捕获异常记为 unhandled**：DO 内一切 `void` promise 必须 `.catch`；SSE 读端收尾前读净 pending read（session-events.test.ts 已有先例注释）。
- **模型上游的可测性**：上游地址必须经 env 注入，集成测试指向 mock、真实凭据只进冒烟。GLM chat completions 的 thinking / tool_call 语义与 wire 事件的映射需 M1 / M2 实测对齐，发现差异即回写 runtime.md。
- **流中途断掉无法续传**（平台事实）：恢复只有重发 / 取回 / 合成三选一；prefill 实测定论前不得假设策略 2 可行。
- **单写者**：一切事件写入只经 DO 的 `appendEvent`；`modules/session` 不直写 DO 存储、不旁路广播。
- **D1 投影容忍秒级陈旧**：回写失败只记日志；`statuses[]` 列表过滤按投影语义验收，不追求强一致。
- **Sandbox 依赖容器进不了 vitest**：工具执行以接口注入隔离，测试覆盖靠 mock 上游 + fake 执行器组合，真实沙箱只在冒烟与脚本验证。
