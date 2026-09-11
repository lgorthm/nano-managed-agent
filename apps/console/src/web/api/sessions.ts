import type {
  ListQuery,
  Page,
  PersistedEvent,
  SendEventsInput,
  Session,
  SessionCreateInput,
  SessionEventListQuery,
  SessionUpdateInput,
  StreamEvent,
} from "@nano/shared/glm";
import { glmFetch, glmFetchPage, subscribeGlmStream } from "./client";

const BASE = "/agent/managed/v1/sessions";

export function listSessions(query: ListQuery = {}) {
  return glmFetchPage<Session>(BASE, query);
}

export function getSession(sessionId: string) {
  return glmFetch<Session>(`${BASE}/${sessionId}`);
}

export function createSession(input: SessionCreateInput) {
  return glmFetch<Session>(BASE, { method: "POST", body: JSON.stringify(input) });
}

export function updateSession(sessionId: string, input: SessionUpdateInput) {
  return glmFetch<Session>(`${BASE}/${sessionId}`, { method: "POST", body: JSON.stringify(input) });
}

export function deleteSession(sessionId: string) {
  return glmFetch<void>(`${BASE}/${sessionId}`, { method: "DELETE" });
}

/** 历史事件;断线重连时先拉列表再订阅,按事件 id 去重 */
export function listSessionEvents(sessionId: string, query: SessionEventListQuery = {}) {
  return glmFetchPage<PersistedEvent>(`${BASE}/${sessionId}/events`, query);
}

export function sendSessionEvents(sessionId: string, input: SendEventsInput) {
  return glmFetch<{ data: PersistedEvent[] }>(`${BASE}/${sessionId}/events`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** 订阅实时事件(SSE,只推送连接后的新事件) */
export function subscribeSessionEvents(
  sessionId: string,
  onEvent: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return subscribeGlmStream(
    `${BASE}/${sessionId}/events/stream`,
    (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as StreamEvent);
      } catch {
        onEvent({ raw: msg.data, type: msg.event });
      }
    },
    signal,
  );
}

/** 供页面直接取分页信封类型 */
export type { Page };
