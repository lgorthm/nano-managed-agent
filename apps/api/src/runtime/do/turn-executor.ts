/**
 * turn 执行器 — M2 工具循环(docs/session/runtime.md §4)。
 * 每个迭代两阶段:模型调用(装配上下文 → 流式调用 → 终事件)与工具批次
 * (agent.tool_use 落库 → 沙箱执行 → agent.tool_result 落库),工具完成后
 * 回到模型迭代,直到无工具调用即 usage + end_turn 收尾。
 *
 * 恢复语义(§6):终事件 id 与工具批次随 snapshot 预生成,append 去重兜底;
 * 已落 tool_result 的工具不重跑,「执行完成与落库之间」的逐出接受重跑一次。
 * 中断语义(§4.4):模型流逐 chunk 掐断;沙箱工具在途的执行完再停,未开始的
 * 以 is_error 的合成结果补齐 tool_use/tool_result 配对(缺失会让下一轮上下文
 * 不完整)。执行代际(executionToken)让被取代的执行(测试的逐出模拟、
 * 双重恢复竞态)静默退出,不与新执行交叉落事件。
 */
import {
  assembleChatMessages,
  validateToolInvocation,
  type ChatMessage,
  type ChatToolDefinition,
  type DeltaEventType,
  type JsonValue,
  type PersistedEventJson,
  type StopReason,
  type UsagePayload,
} from "@nano/shared";
import { ModelAbortedError, streamChatCompletion, type GlmModelConfig } from "../model-client";
import { newEventId } from "../ids";
import type { ToolRunner } from "../tools/runner";

/** 工具批次条目:身份与两个终事件 id 全部预生成(重试幂等的锚点) */
export interface PendingToolCall {
  /** 模型侧调用 id(上游回指用;缺失时本地生成) */
  callId: string;
  name: string;
  inputJson: string;
  toolUseEventId: string;
  toolResultEventId: string;
  /** §6:tool_result 已落库——恢复时跳过重跑 */
  resultAppended: boolean;
}

/** 细粒度检查点(§3/§4.1):身份进列,这里只有循环内部状态;恢复时沿用预生成 id */
export interface TurnSnapshot {
  iteration: number;
  callId: string;
  thinkingEventId: string;
  messageEventId: string;
  /** 已落库的终事件:恢复重发时跳过(内容以事件日志为准,append 去重兜底) */
  completed: Array<"agent.thinking" | "agent.message">;
  partialThinking: string;
  partialMessage: string;
  /** 待执行 / 执行到一半的工具批次(恢复重入点) */
  pendingToolCalls: PendingToolCall[];
}

function parsePendingToolCalls(raw: unknown): PendingToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is PendingToolCall =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as PendingToolCall).callId === "string" &&
      typeof (item as PendingToolCall).name === "string" &&
      typeof (item as PendingToolCall).inputJson === "string" &&
      typeof (item as PendingToolCall).toolUseEventId === "string" &&
      typeof (item as PendingToolCall).toolResultEventId === "string" &&
      typeof (item as PendingToolCall).resultAppended === "boolean",
  );
}

/** 防御性解析:行在但 snapshot 损坏(如 M0/M1 旧形态)时返回 null,调用方重生成 */
export function parseTurnSnapshot(raw: unknown): TurnSnapshot | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TurnSnapshot>;
    if (
      typeof parsed.callId !== "string" ||
      typeof parsed.thinkingEventId !== "string" ||
      typeof parsed.messageEventId !== "string" ||
      !Array.isArray(parsed.completed)
    ) {
      return null;
    }
    return {
      iteration: typeof parsed.iteration === "number" ? parsed.iteration : 0,
      callId: parsed.callId,
      thinkingEventId: parsed.thinkingEventId,
      messageEventId: parsed.messageEventId,
      completed: parsed.completed.filter(
        (item): item is "agent.thinking" | "agent.message" =>
          item === "agent.thinking" || item === "agent.message",
      ),
      partialThinking: typeof parsed.partialThinking === "string" ? parsed.partialThinking : "",
      partialMessage: typeof parsed.partialMessage === "string" ? parsed.partialMessage : "",
      pendingToolCalls: parsePendingToolCalls(parsed.pendingToolCalls),
    };
  } catch {
    return null;
  }
}

/** 模型调用配置:model 与 tools 来自会话的 agent_config 快照,baseUrl/apiKey 来自 env */
export interface TurnModelConfig {
  system: string | null;
  model: GlmModelConfig;
  /** 模型侧工具定义(M2 只含 always_allow;always_ask 挂起属 M3) */
  tools: ChatToolDefinition[];
}

/** 执行器可用的宿主能力(SessionDo 实现) */
export interface TurnHost {
  /** 产出事件:消息体唯一落库点;options.id 传执行器预生成的 id(重试幂等) */
  appendProducedEvent(
    type:
      | "agent.thinking"
      | "agent.message"
      | "agent.tool_use"
      | "agent.tool_result"
      | "session.usage"
      | "session.error"
      | "system.message",
    fields: Record<string, JsonValue>,
    options?: { id?: string },
  ): void;
  /** 消费积压的 user.message(processed_at 回填),返回消费条数 */
  consumePendingUserMessages(): number;
  /** 是否仍有未消费输入(turn 收尾前的积压检查,§4.4) */
  hasPendingUserMessages(): boolean;
  /** user.interrupt 置位的中断标志 */
  isInterrupted(): boolean;
  /** 会话存储已随删除联动 wipe */
  isDeleted(): boolean;
  /** turn 终局:status_idle(stop_reason)+ 删 turn 行 + 状态机回 idle + D1 投影回写 */
  finishTurn(turnId: string, stopReason: StopReason, usage: UsagePayload): Promise<void>;
  /** 推送流上 delta 帧(不落库);seq 为终事件 seq 的估计值(仅排序参考,客户端以 event_id 为准) */
  emitDelta(type: DeltaEventType, eventId: string, seq: number, text: string): void;
  /** 细粒度检查点落盘(同步 SQLite,整体替换) */
  saveTurnSnapshot(turnId: string, iteration: number, snapshot: TurnSnapshot): void;
  /** 读取事件日志终事件(seq 升序,含未消费输入)供上下文装配 */
  loadEventsForContext(): PersistedEventJson[];
  /** 读取本轮模型调用配置(D1 的 agent_config 快照 + env 凭据),每 turn 一次 */
  loadTurnConfig(): Promise<TurnModelConfig>;
  /** 终事件 seq 的估计值(delta 帧的排序参考) */
  estimateNextSeq(): number;
  /** 工具执行层(§4.5 注入边界):无可用工具时返回 null */
  createToolRunner(): Promise<ToolRunner | null>;
  /** 当前执行代际:startTurn / 恢复各持唯一 token,被取代的执行静默退出 */
  executionToken(): number;
  isExecutionCurrent(token: number): boolean;
}

const ZERO_USAGE: UsagePayload = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

/** delta 缓冲窗口(§7:50–100ms 或换行) */
const DELTA_FLUSH_WINDOW_MS = 80;
/** snapshot 节奏(§3:~64 chunk 或 ~500ms) */
const SNAPSHOT_CHUNK_INTERVAL = 64;
const SNAPSHOT_TIME_INTERVAL_MS = 500;

function freshSnapshot(turnId: string, iteration: number): TurnSnapshot {
  return {
    iteration,
    callId: `${turnId}:${iteration}`,
    thinkingEventId: newEventId(),
    messageEventId: newEventId(),
    completed: [],
    partialThinking: "",
    partialMessage: "",
    pendingToolCalls: [],
  };
}

/** 初始检查点:随 turn 行一同落库(startTurn),任何时刻崩溃恢复都有完整身份可用 */
export function initialTurnSnapshot(turnId: string): TurnSnapshot {
  return freshSnapshot(turnId, 0);
}

/** 崩溃恢复的续跑信息(§6 策略 1:同 iteration 重发,终事件 id 沿用 snapshot) */
export interface TurnResume {
  iteration: number;
  snapshot: TurnSnapshot;
}

/** 模型生成的入参不可信:非法 JSON 以标记对象进入(会被入参校验拒绝) */
function parseToolInput(inputJson: string): JsonValue {
  try {
    return JSON.parse(inputJson) as JsonValue;
  } catch {
    return { __invalid_json: inputJson };
  }
}

export async function runTurn(host: TurnHost, turnId: string, resume?: TurnResume): Promise<void> {
  const config = await host.loadTurnConfig();
  const token = host.executionToken();
  const current = (): boolean => host.isExecutionCurrent(token);
  const runner = config.tools.length > 0 ? await host.createToolRunner() : null;
  let toolsRan = false;
  if (runner !== null) {
    // 冷启掩体(§4.5):与首次模型调用并行预热,失败静默(真正用时会再惰性建)
    void runner.warmup();
  }

  const totalUsage: UsagePayload = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const addUsage = (usage: UsagePayload): void => {
    totalUsage.input_tokens += usage.input_tokens;
    totalUsage.output_tokens += usage.output_tokens;
    totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens;
  };

  let iteration = resume?.iteration ?? 0;
  let resumed = resume?.snapshot ?? null;

  for (;;) {
    // ---- 阶段一:执行遗留的工具批次(上一模型调用的产出,或恢复重入) ----
    const snapshot = resumed ?? freshSnapshot(turnId, iteration);
    resumed = null;

    if (snapshot.pendingToolCalls.length > 0) {
      if (runner === null) {
        // 不可达防御:模型未获工具定义就不会发起调用;恢复旧快照同理
        host.appendProducedEvent("session.error", { message: "Tool runner is unavailable." });
        await host.finishTurn(turnId, { type: "interrupted" }, ZERO_USAGE);
        return;
      }
      host.saveTurnSnapshot(turnId, iteration, snapshot);
      let interrupted = false;
      for (const call of snapshot.pendingToolCalls) {
        if (call.resultAppended) continue; // §6:已落 tool_result 的不重跑
        if (host.isInterrupted() || host.isDeleted()) {
          // §4.4:未开始的工具跳过执行,合成 is_error 结果补齐配对
          host.appendProducedEvent(
            "agent.tool_result",
            {
              tool_use_id: call.toolUseEventId,
              content: [{ type: "text", text: "Tool execution was skipped because the session was interrupted." }],
              is_error: true,
            },
            { id: call.toolResultEventId },
          );
          call.resultAppended = true;
          continue;
        }
        const input = parseToolInput(call.inputJson);
        // 协议级校验(执行器做,与 runner 实现无关):失败不进沙箱,直接喂回错误
        const invalid = validateToolInvocation(call.name, input);
        if (invalid !== null) {
          host.appendProducedEvent(
            "agent.tool_result",
            { tool_use_id: call.toolUseEventId, content: [{ type: "text", text: invalid }], is_error: true },
            { id: call.toolResultEventId },
          );
          call.resultAppended = true;
          host.saveTurnSnapshot(turnId, iteration, snapshot);
          continue;
        }
        const outcome = await runner.run({ toolUseId: call.toolUseEventId, name: call.name, input });
        if (!current()) return; // 被取代的执行(逐出模拟 / 双重恢复):静默退出
        toolsRan = true;
        host.appendProducedEvent(
          "agent.tool_result",
          {
            tool_use_id: call.toolUseEventId,
            content: [{ type: "text", text: outcome.content }],
            ...(outcome.isError ? { is_error: true } : {}),
          },
          { id: call.toolResultEventId },
        );
        call.resultAppended = true;
        host.saveTurnSnapshot(turnId, iteration, snapshot);
      }
      interrupted = host.isInterrupted() || host.isDeleted();
      snapshot.pendingToolCalls = [];
      host.saveTurnSnapshot(turnId, iteration, snapshot);
      if (interrupted) {
        if (toolsRan && runner !== null) await runner.harvestOutputs();
        await host.finishTurn(turnId, { type: "interrupted" }, ZERO_USAGE);
        return;
      }
      // 工具结果就绪,带着 tool 轮上下文进入下一次模型调用
      iteration += 1;
      continue;
    }

    // ---- 阶段二:模型调用 ----
    const events = host.loadEventsForContext();
    const messages: ChatMessage[] = assembleChatMessages({ system: config.system, events });
    host.consumePendingUserMessages();

    // 空上下文(无可回放的输入)不调用模型,直接收尾——防御分支,正常路径不可达
    if (messages.length === 0) {
      host.appendProducedEvent("session.usage", { ...ZERO_USAGE });
      await host.finishTurn(turnId, { type: "end_turn" }, ZERO_USAGE);
      return;
    }

    host.saveTurnSnapshot(turnId, iteration, snapshot);
    const controller = new AbortController();
    const deltaBuffer: Record<"thinking" | "message", string> = { thinking: "", message: "" };
    const deltaTimers: Partial<Record<"thinking" | "message", ReturnType<typeof setTimeout>>> = {};
    let chunkCount = 0;
    let lastSnapshotAt = Date.now();

    const emitBuffered = (kind: "thinking" | "message"): void => {
      const timer = deltaTimers[kind];
      if (timer !== undefined) {
        clearTimeout(timer);
        deltaTimers[kind] = undefined;
      }
      const text = deltaBuffer[kind];
      if (text === "") return;
      deltaBuffer[kind] = "";
      host.emitDelta(
        kind === "thinking" ? "agent.thinking" : "agent.message",
        kind === "thinking" ? snapshot.thinkingEventId : snapshot.messageEventId,
        host.estimateNextSeq(),
        text,
      );
    };
    const emitAll = (): void => {
      emitBuffered("thinking");
      emitBuffered("message");
    };

    try {
      const result = await streamChatCompletion(config.model, messages, {
        signal: controller.signal,
        onDelta: (kind, text) => {
          // 逐 chunk 检查中断与删除(§4.4):掐断请求,不落半截产出
          if (host.isInterrupted() || host.isDeleted()) {
            controller.abort();
            return;
          }
          if (kind === "thinking") {
            snapshot.partialThinking += text;
            deltaBuffer.thinking += text;
          } else {
            snapshot.partialMessage += text;
            deltaBuffer.message += text;
          }
          if (deltaBuffer[kind].includes("\n")) {
            emitBuffered(kind);
          } else if (deltaTimers[kind] === undefined) {
            deltaTimers[kind] = setTimeout(() => emitBuffered(kind), DELTA_FLUSH_WINDOW_MS);
          }
          chunkCount += 1;
          if (chunkCount % SNAPSHOT_CHUNK_INTERVAL === 0 || Date.now() - lastSnapshotAt >= SNAPSHOT_TIME_INTERVAL_MS) {
            host.saveTurnSnapshot(turnId, iteration, snapshot);
            lastSnapshotAt = Date.now();
          }
        },
      }, config.tools);

      emitAll(); // 残余 delta 先于终事件冲净(§7:delta 在前、终事件在后)
      addUsage(result.usage);
      if (!current()) return;
      if (host.isDeleted() || host.isInterrupted()) {
        if (toolsRan && runner !== null) await runner.harvestOutputs();
        await host.finishTurn(turnId, { type: "interrupted" }, ZERO_USAGE);
        return;
      }
      if (result.thinking !== "" && !snapshot.completed.includes("agent.thinking")) {
        host.appendProducedEvent(
          "agent.thinking",
          { content: [{ type: "text", text: result.thinking }] },
          { id: snapshot.thinkingEventId },
        );
        snapshot.completed.push("agent.thinking");
      }
      if (result.message !== "" && !snapshot.completed.includes("agent.message")) {
        host.appendProducedEvent(
          "agent.message",
          { content: [{ type: "text", text: result.message }] },
          { id: snapshot.messageEventId },
        );
        snapshot.completed.push("agent.message");
      }

      if (result.toolCalls.length > 0) {
        // 工具调用先落 agent.tool_use(事实记录),批次随 snapshot 交阶段一执行
        snapshot.pendingToolCalls = result.toolCalls.map((call, index) => ({
          callId: call.id !== "" ? call.id : `${turnId}:${iteration}:call_${index}`,
          name: call.name,
          inputJson: call.arguments,
          toolUseEventId: newEventId(),
          toolResultEventId: newEventId(),
          resultAppended: false,
        }));
        host.saveTurnSnapshot(turnId, iteration, snapshot);
        for (const call of snapshot.pendingToolCalls) {
          host.appendProducedEvent(
            "agent.tool_use",
            { name: call.name, input: parseToolInput(call.inputJson) },
            { id: call.toolUseEventId },
          );
        }
        resumed = snapshot; // 下一轮循环进阶段一
        continue;
      }

      // §4.4 收尾窗口竞态:收尾前仍有未消费输入则本 turn 内继续消费
      if (host.hasPendingUserMessages()) {
        iteration += 1;
        continue;
      }

      if (toolsRan && runner !== null) await runner.harvestOutputs();
      host.appendProducedEvent("session.usage", { ...totalUsage });
      await host.finishTurn(turnId, { type: "end_turn" }, totalUsage);
      return;
    } catch (err) {
      emitAll();
      for (const timer of Object.values(deltaTimers)) {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (err instanceof ModelAbortedError || controller.signal.aborted) {
        if (toolsRan && runner !== null) await runner.harvestOutputs();
        await host.finishTurn(turnId, { type: "interrupted" }, ZERO_USAGE);
        return;
      }
      throw err; // 网络 / 上游错误 → DO 的 turnFailed 统一 session.error(分诊细化属 M4)
    }
  }
}
