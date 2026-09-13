import type { Context } from "hono";
import { DELTA_EVENT_TYPES, type DeltaEventType } from "@nano/shared";
import type { AppEnv } from "../../../env";
import { invalidRequestError } from "../../../lib/errors";
import { sessionService } from "../service";

/**
 * 解析 delta 订阅参数(docs/session/api/subscribe-events.md):
 * event_deltas[] 与兼容写法 event_deltas 合计 ≤ 100,值仅 agent.message / agent.thinking。
 */
function parseDeltaSubscription(c: Context<AppEnv>): DeltaEventType[] {
  const raw = [...(c.req.queries("event_deltas[]") ?? []), ...(c.req.queries("event_deltas") ?? [])];
  const deltas: DeltaEventType[] = [];
  for (const value of raw.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean)) {
    if (!(DELTA_EVENT_TYPES as readonly string[]).includes(value)) {
      throw invalidRequestError(`Query parameter event_deltas[] has an invalid value "${value}".`, {
        param: "event_deltas[]",
        allowed: DELTA_EVENT_TYPES,
      });
    }
    deltas.push(value as DeltaEventType);
  }
  if (deltas.length > 100) {
    throw invalidRequestError("Query parameters event_deltas[] accept at most 100 values.");
  }
  return [...new Set(deltas)];
}

/** GET /v1/sessions/{sessionId}/events/stream — SSE 订阅实时事件(只推连接后的新事件) */
export async function streamSessionEvents(c: Context<AppEnv>) {
  const deltas = parseDeltaSubscription(c);
  const stream = await sessionService.streamEvents(c.env, c.req.param("sessionId") ?? "", deltas);
  // 中介管道:客户端断开时 pipeTo 在本层吸收取消(取消属正常终止),
  // 不让 RPC 流的拆除噪声漏成 unhandled;DO 侧靠写失败感知并清理订阅
  const passthrough = new IdentityTransformStream();
  void stream.pipeTo(passthrough.writable).catch(() => undefined);
  return new Response(passthrough.readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
