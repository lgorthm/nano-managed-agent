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
| M1 对话闭环 | 真实模型流 → delta → 终事件 → usage；两级检查点与崩溃恢复 | runtime.md §3/§4/§6 | 大 | 代码与测试完成（真实凭据冒烟与 prefill 实测待做） |
| M2 沙箱工具 | 七个内置工具执行 + 挂载 / skills 供给 + tool_use / tool_result | runtime.md §1/§4/§4.5 | 大 | 完成（真实沙箱冒烟已过；真实 GLM 凭据端到端随 M1 遗留项） |
| M3 确认与打断 | always_ask 挂起 / 恢复、user.interrupt、running 追加消息 | runtime.md §4.3/§4.4 | 中 | 完成 |
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

null-turn 整体替换为真实循环；交付「发一条 user.message，收到 thinking / message 的 delta 与终事件、真实 usage」。代码与测试已完成（38 个测试文件、314 例全绿）；两项依赖真实凭据的验收留待（见下）。另外两点实现时的偏差：`user.interrupt` 的流掐断（逐 chunk 检查 + AbortController）从 M3 提前到 M1 一并实现——执行器重写时顺势就位，M3 只剩在途沙箱工具「执行完再停」的语义；stats 计时口径归 M4 定稿（D1 无 stats 列，序列化仍固定 0），M1 只回写 usage 三列。

**协议层（纯函数先行）：**

- [x] shared 新建上下文组装纯函数 `session/context.ts`（事件数组 + 最终配置 → GLM chat completions `messages`）：system 拼装（agent_config 快照的 system prompt）；历史事件映射（user.message → user 轮，agent.message → assistant 轮，agent.thinking 不回放——推理模型的输入侧回传会被拒绝；M2 的 tool_use / tool_result 映射与三期 compaction 留扩展位）。content 块映射：text 折叠为字符串、image 转 data URL parts、document(text) 内联、document(file_id) 占位（M2 物化）。
- [x] 单测 `context.test.ts`：system 拼装、user / assistant 交替、thinking 跳过、非模型事件跳过、未消费输入包含、载荷边界、image / document 映射。

**模型客户端：**

- [x] `runtime/model-client.ts`：GLM chat completions 流式客户端——fetch + SSE 解析（`delta.reasoning_content` → thinking、`delta.content` → message、`include_usage` 末块计量）；`AbortController` 掐断（abort 时显式 cancel 流，吸收 workerd 运行时内部的取消拒绝）；凭据与上游地址经 env 注入（`GLM_API_KEY` secret + `GLM_API_BASE` var，命名对齐 console 侧约定；`.dev.vars.example` 同步）——集成测试指向 mock 上游，真实 key 只用于冒烟。
- [x] 带退避的 fetch 包装（§0 的「十行包装」）：仅连接类错误重试（200ms / 500ms 两退），流已建立不重试；非 2xx 抛 `ModelHttpError`（M4 细化分诊）。

**执行器真实化（`turn-executor.ts` 整体替换，`TurnHost` 增能力）：**

- [x] 循环迭代：装配上下文（含未消费输入，消费即回填）→ 预生成终事件 id 进 snapshot → 流式调用（确定性 `call_id = turn_id:iteration`）；收尾前积压检查，有则本 turn 内继续消费。
- [x] delta 缓冲：换行即冲、否则 80ms 窗口 → `emitDelta`；流终结先冲净残余再落终事件（§7 的 delta 在前）；未订阅 delta 的连接只见终事件。
- [x] snapshot 节奏落盘（§3）：每 ~64 chunk 或 ~500ms 整体替换（iteration / partial_text / 预生成 id / call_id / 已落库终事件标记）；初始检查点随 turn 行落库（`startTurn` 传 resume），任何时刻崩溃恢复都有完整身份。
- [x] 流终结 → `appendProducedEvent`（agent.thinking / agent.message，用预生成 id）→ 无 tool_use（M1 不向上游传 tools）→ `session.usage`（上游计量）→ `finishTurn(end_turn)`；usage 三列回写 D1 投影（stats 计时口径 M4 定稿）。
- [x] keepAlive 间隔可注入（`TURN_KEEPALIVE_INTERVAL_MS`，默认 30s、测试 2s，§5）——恢复类用例等得到 alarm 巡检。

**崩溃恢复（§6）：**

- [x] 构造唤醒（constructor kick）与 alarm 巡检共用恢复入口 `recoverOrphanTurnIfAny`，替换 M0 的简化分支：策略 1 重发（从日志重组上下文、同 turnId / iteration / call_id、终事件 id 沿用 snapshot，append 去重兜底；snapshot 标记的已落库终事件不重发）；恢复前防御性归一 running 状态。测试经 `simulateEvictionForTest` RPC 走同一条恢复路径（vitest 无法真正逐出 DO 实例）。
- [ ] 实测 GLM assistant prefill / 取回已存响应（开放问题 2）：需真实凭据；结论回写 runtime.md §11，决定策略 2（部分落盘 + 合成继续）是否实现。**未做**——当前策略 1 重发已可用。
- [x] 恢复动作外发 `system.message`；在途执行与恢复的竞态由 `turnFailed` 的 turn 行存在性守卫兜底（行已删则只复位内存，不补发 session.error）。

**测试与验收：**

- [x] DO 集成（mock 上游返回受控 SSE，`test/mock-model/`：node 侧服务 + workerd 侧 admin 控制，脚本按消息文本 match 匹配防并行抢占）：事件序 status_running → thinking / message → usage → idle{end_turn}；usage 真实值回写 D1；delta 帧先于终事件且 `event_id` 一致、未订阅只见终事件；多轮上下文（assistant 回放、thinking 不回放）；system / model / 凭据上行；流中途 interrupt 掐断（无半截终事件、interrupted 收尾）；恢复（system.message + 同上下文重发 + 终事件无重复）。既有 15 例的事件序列预期同步更新（session-events 19 例全绿，全仓 314 例）。
- [x] 恢复集成：孤儿 turn（挂起流）→ `simulateEvictionForTest` → 巡检恢复 → 断言终事件无重复 + system.message 已外发 + 第二次请求与首次同上下文。
- [ ] curl 冒烟（真实凭据）：一轮真实对话，肉眼比对事件流与 SSE。**未做**——`GLM_API_KEY` 需真实 secret（`.dev.vars` 配好后按 send-events / subscribe-events 文档示例执行）。

---

## M2 沙箱工具 — tool_use / tool_result

**决策先行（开放问题 1）：**

- [x] 沙箱生命周期定稿（2026-09，结论与平台事实见 runtime.md §4.5）：**按需冷启 + 平台默认 `sleepAfter`（10m）空闲回收，不启用 `keepAlive`**——sleep 即状态清零是平台事实，「常驻」买不到持久性，nano 必须自建工作区再物化；默认 10m 窗口免费提供「会话级半常驻」（活跃对话几乎不冷启）。`rescheduled` 维持三期预留：nano 的冷启嵌在活跃 turn 内（工具调用阻塞等它），无独立可观测的会话级重调度时刻，强行外发只是 wire 噪声。§11 已回写。

**沙箱接入：**

- [x] Sandbox SDK 接入（`@cloudflare/sandbox@0.12.9`）：wrangler `containers` 配置（lite 实例、镜像钉 `sandbox.Dockerfile` = `docker.io/cloudflare/sandbox:0.12.9-python`，与 npm 版本同步）、`SANDBOX` DO 绑定（migrations v2）、入口导出 `Sandbox` 类；每会话一个沙箱（实例 id = sessionId，惰性创建），`sleepAfter: "10m"`、keepAlive 恒不启用。
- [x] 工作区物化协议（§4.5 推论，`runtime/tools/runner.ts`）：幂等标记（容器内 `/tmp/.nano-materialized` + DO 内存标记）判定再物化；物化内容 = 挂载文件（R2 `files/{id}` → mount_path，写后 `chmod -R a-w` 尽力只读）+ skills（D1 `skill_files` → `/mnt/skills/<directory>`）+ outputs 回填（R2 `sessions/{id}/outputs/` → `/mnt/session/outputs`）；**outputs 在每个 turn 收尾（含 interrupted）同步进 R2**；`/workspace` 其余状态视为易失。
- [x] 冷启掩体：turn 启动（存在 always_allow 工具时）fire-and-forget `warmup()`，与首次模型调用并行；失败静默，首个工具调用再惰性建。
- [x] 删除 / 归档联动（§4.5 推论）：删除走 `wipe()` 先 `destroySandbox()` 再清存储；归档 service 成功后调 `destroySandbox()`（失败只记日志，不阻塞归档）。
- [x] `environment_snapshot` 消费：物化时按快照 packages 尽力安装（apt/pip/npm/go/cargo/gem，缺包管理器则跳过；镜像选 python 变体），不回读 `environments` 表；networking 三期（沙箱侧无每会话出站策略原语）。
- [x] 工具执行层接口化（`runtime/tools/runner.ts` 的 `ToolRunner`）：`warmup / run / harvestOutputs / destroy` 四方法；mock 实现（`TOOL_SANDBOX_MOCK=1`，vitest 注入）与真实实现同接口分流；七个工具映射（bash=exec、read/write/edit=文件 API、grep/find/ls=shell 命令），输出截断 200k 字符。

**循环插入工具执行：**

- [x] 向上游传 tools（`resolveBuiltinTools` 折叠归一化 toolset → 模型侧 function 定义；**M2 只放行 always_allow，always_ask 不进模型 tools**——挂起语义属 M3，先用过滤保证不产生不可处理的调用）；模型流式 tool_calls 按 index 累积解析；`agent.tool_use`（name + input）与 `agent.tool_result`（tool_use_id + content + is_error）落库，tool_use_id 即事件 id；上下文组装补映射：连续 tool_use 合并为一条带 tool_calls 的 assistant 轮、tool_result 为 tool 轮回指（`agent.message` 与 tool_use 分属两条 assistant 轮）；协议级入参校验（`validateToolInvocation`，执行器做、与 runner 实现无关）失败以 is_error 结果喂回模型，不炸 turn；usage 跨迭代累计后单条 `session.usage` 落库并回写 D1。
- [x] 工具幂等（§6）：批次随 snapshot 预生成两个终事件 id，`resultAppended` 逐调用记录「已落 tool_result 不重跑」；恢复重入工具批次（不重放模型请求）；中断在途语义（§4.4）——在途执行完再停、未开始的合成 is_error 结果补齐配对；执行代际（executionToken）让被取代的执行静默退出（逐出模拟与双重恢复的竞态）。

**测试与验收：**

- [x] mock 上游带 tool_use 的流 → mock 执行器：`session-tools.test.ts` 6 例——bash 往返（tool_use/tool_result 配对、事件 id 即 tool_use_id、usage 跨迭代累计并回写 D1、第二次请求的 tool_calls / tool 轮上下文、七个工具定义上行）；一次多工具按序配对；非法入参与未知工具（is_error 喂回、turn 继续）；always_ask 不进模型 tools；中断在途（在途执行完再停、未开始的合成 is_error、无后续模型调用）；逐出恢复（重入工具批次不重放模型请求、终事件无重复）。shared 侧补 tool 映射与工具解析 / 校验单测（context / tools.test.ts）。全仓 39 文件 320 例与 typecheck 绿。
- [x] 冒烟：真实沙箱执行一次 bash 工具，产物落 R2 可读。已验证（本地 Docker + `.dev.vars` 把 `GLM_API_BASE` 指向一次性 mock 上游、模型侧脚本化 tool_calls）：真实容器冷启与物化正常，`agent.tool_use` / `agent.tool_result` 配对且 tool_use_id 即事件 id，`tool_result` 内容为真实容器输出，outputs 于 turn 收尾落 R2（`wrangler r2 object get … --local` 读回一致），usage 跨迭代累计回写 D1。真实 GLM 凭据的端到端对话仍待（同 M1 遗留两项）。

---

## M3 确认与打断

**always_ask 挂起 / 恢复（§4.3）：**

- [x] 循环遇 always_ask 工具：不执行、记入待审批集合（`pending_confirmations` 表,预生成 result 事件 id）→ `finishTurn(requires_action, event_ids)` → 行删除即挂起；挂起前 usage 照常落事件与 D1 投影（不因挂起丢失计量）。always_ask 工具随 tools 一并上行（模型看得见,执行侧分叉）。
- [x] 待审批集合持久化 + `user.tool_confirmation` 校验放开（对照 GLM 权限文档逐条）：tool_use_id 必须恰在等待集合中（未知 400 / 已裁决 400 / 同批重复 400）；一次请求可带多条确认；**全部**待审批有裁决才回 running——逐条执行裁决（allow 经入参校验后执行；deny 不执行,合成含 `deny_message` is_error 拒绝结果）→ 删行 → 新 turn 让模型带着全部结果继续。裁决在行内持久化,确认执行被逐出打断由恢复入口重入（幂等,预生成 id 去重 + 执行代际静默旧执行）;挂起期间消息排队不开新 turn,由续跑的 turn 消费。
- [x] 确认事件的 `processed_at` 恒为 `null`（与 GLM「部分确认/中断事件为 null」对齐;不回填）。

**user.interrupt 完整语义（§4.4）：**

- [x] 已全部落地：流掐断随 M1（逐 chunk 检查 + `AbortController` + 不落半截终事件）；在途沙箱工具执行完再停、未开始的合成 `is_error` 结果补齐配对随 M2（session-tools 集成用例覆盖）。

**running 中追加消息（§4.4）：**

- [x] 语义随 M1/M2 的执行器循环落地（每次迭代重新装配上下文、收尾前积压检查续迭代）;M3 补集成用例钉住（追加消息不打断在途请求,后续迭代消费,消息序 = 事件序）。

**测试与验收：**

- [x] `session-confirmations.test.ts` 7 例——挂起（requires_action 带 event_ids、不执行、usage 落库、回 idle）;allow 全链路（执行 + 新 turn 到 end_turn、usage 两段累计进 D1）;deny（is_error 拒绝结果含 deny_message、结果回喂模型）;部分确认不续跑、全部裁决后按挂起序执行;无效确认三态 400（未知 / 同批重复 / 已裁决）;逐出恢复重入确认链（结果不重复、status_running 恰两次）;running 追加消息后续迭代消费。既有两例按 M3 行为更新（always_ask 随 tools 上行;无待审批确认 400 保留）。全仓 40 文件 327 例与 typecheck 绿。
- [x] curl 冒烟:真实沙箱冒烟已在 M2 覆盖工具执行链;M3 确认链与 mock 上游的集成用例覆盖（真实 GLM 凭据端到端随 M1 遗留项）。

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
