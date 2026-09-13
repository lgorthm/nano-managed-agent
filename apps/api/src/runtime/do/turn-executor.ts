/**
 * turn 执行器 — M1 对话闭环(docs/session/runtime.md §4)。
 * 循环:装配上下文(事件日志 + agent_config 快照)→ 预生成终事件 id 进
 * snapshot → 流式调 GLM(delta 缓冲推送、snapshot 节奏落盘)→ 终事件落库
 * → 无 tool_use 即 usage + end_turn 收尾;收尾前检查积压输入,有则继续迭代。
 *
 * 宿主能力经 TurnHost 注入(SessionDo 实现);M2 在流终结后插入 tool_use
 * 解析与沙箱执行,本文件的循环骨架不动。
 */
import {
  assembleChatMessages,
  type ChatMessage,
  type DeltaEventType,
  type JsonValue,
  type PersistedEventJson,
  type StopReason,
  type UsagePayload,
} from "@nano/shared";
import { ModelAbortedError, streamChatCompletion, type GlmModelConfig } from "../model-client";
import { newEventId } from "../ids";

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
}

/** 防御性解析:行在但 snapshot 损坏(如 M0 旧形态)时返回 null,调用方重生成 */
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
    };
  } catch {
    return null;
  }
}

/** 模型调用配置:model 来自会话的 agent_config 快照,baseUrl/apiKey 来自 env */
export interface TurnModelConfig {
  system: string | null;
  model: GlmModelConfig;
}

/** 执行器可用的宿主能力(SessionDo 实现;M2 增沙箱执行接口) */
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

export async function runTurn(host: TurnHost, turnId: string, resume?: TurnResume): Promise<void> {
  const config = await host.loadTurnConfig();
  let iteration = resume?.iteration ?? 0;
  let resumed = resume?.snapshot ?? null;

  for (;;) {
    const events = host.loadEventsForContext();
    const messages: ChatMessage[] = assembleChatMessages({ system: config.system, events });
    host.consumePendingUserMessages();

    // 空上下文(无可回放的输入)不调用模型,直接收尾——防御分支,正常路径不可达
    if (messages.length === 0) {
      host.appendProducedEvent("session.usage", { ...ZERO_USAGE });
      await host.finishTurn(turnId, { type: "end_turn" }, ZERO_USAGE);
      return;
    }

    const snapshot = resumed ?? freshSnapshot(turnId, iteration);
    resumed = null;
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
          // delta 缓冲:换行即冲,否则 80ms 窗口
          if (deltaBuffer[kind].includes("\n")) {
            emitBuffered(kind);
          } else if (deltaTimers[kind] === undefined) {
            deltaTimers[kind] = setTimeout(() => emitBuffered(kind), DELTA_FLUSH_WINDOW_MS);
          }
          // snapshot 节奏落盘(§3):同步、整体替换
          chunkCount += 1;
          if (chunkCount % SNAPSHOT_CHUNK_INTERVAL === 0 || Date.now() - lastSnapshotAt >= SNAPSHOT_TIME_INTERVAL_MS) {
            host.saveTurnSnapshot(turnId, iteration, snapshot);
            lastSnapshotAt = Date.now();
          }
        },
      });

      emitAll(); // 残余 delta 先于终事件冲净(§7:delta 在前、终事件在后)
      if (host.isDeleted() || host.isInterrupted()) {
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

      // §4.4 收尾窗口竞态:收尾前仍有未消费输入则本 turn 内继续消费
      if (host.hasPendingUserMessages()) {
        iteration += 1;
        continue;
      }

      host.appendProducedEvent("session.usage", { ...result.usage });
      await host.finishTurn(turnId, { type: "end_turn" }, result.usage);
      return;
    } catch (err) {
      emitAll(); // 已发出的 delta 无害(终事件补全语义),只保证不再新增
      for (const timer of Object.values(deltaTimers)) {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (err instanceof ModelAbortedError || controller.signal.aborted) {
        // 打断 / 删除:不落半截终事件,积压输入留给下一条消息(§4.4)
        await host.finishTurn(turnId, { type: "interrupted" }, ZERO_USAGE);
        return;
      }
      throw err; // 网络 / 上游错误 → DO 的 turnFailed 统一 session.error(分诊细化属 M4)
    }
  }
}
