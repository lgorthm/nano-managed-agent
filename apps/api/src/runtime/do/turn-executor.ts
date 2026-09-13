/**
 * turn 执行器 — M0 的 null-turn(docs/session/runtime.md §4)。
 * 结构与完整循环一致(消费输入 → 模型调用迭代 → 终局);M1 在中间插入
 * 流式模型调用与工具执行,宿主接口不变,本类整体替换。
 */
import type { JsonValue, StopReason, UsagePayload } from "@nano/shared";

/** 执行器可用的宿主能力(SessionDo 实现;M1 替换执行器时接口不动) */
export interface TurnHost {
  /** 产出事件(agent、session、system 三类):消息体唯一落库点 */
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
  ): void;
  /** 消费积压的 user.message(processed_at 回填),返回消费条数 */
  consumePendingUserMessages(): number;
  /** user.interrupt 置位的中断标志 */
  isInterrupted(): boolean;
  /** 会话存储已随删除联动 wipe */
  isDeleted(): boolean;
  /** turn 终局:status_idle(stop_reason)+ 删 turn 行 + 状态机回 idle + D1 投影回写 */
  finishTurn(turnId: string, stopReason: StopReason, usage: UsagePayload): Promise<void>;
}

const ZERO_USAGE: UsagePayload = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };

/**
 * 执行一轮 turn。M0 无模型调用:消费积压输入后直接终局(usage 全零),
 * 用于打通事件链路、状态机门禁与 SSE;M1 在 consume 与终局之间插入循环迭代。
 */
export async function runTurn(host: TurnHost, turnId: string): Promise<void> {
  host.consumePendingUserMessages();

  // M1 起:从事件日志组装 messages → 流式调 GLM(delta → host 的 emitDelta,
  // 终事件经 appendProducedEvent 落库)→ 解析 tool_use → always_ask 挂起
  // (finishTurn requires_action)→ 沙箱执行 → 继续迭代;无 tool_use 即终局。

  if (host.isDeleted()) {
    await host.finishTurn(turnId, { type: "interrupted" }, ZERO_USAGE);
    return;
  }
  if (host.isInterrupted()) {
    // 打断:不落半截产出,直接以 interrupted 收尾;积压输入留在队列等下一条消息
    await host.finishTurn(turnId, { type: "interrupted" }, ZERO_USAGE);
    return;
  }
  host.appendProducedEvent("session.usage", { ...ZERO_USAGE });
  await host.finishTurn(turnId, { type: "end_turn" }, ZERO_USAGE);
}
