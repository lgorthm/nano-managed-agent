import type { Page, PersistedEvent } from '@nano/shared/glm';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { listSessionEvents, subscribeSessionEvents } from '@/api/sessions';
import {
  loadSessionEventHistory,
  mergeSessionEvents,
  retainUnpersistedEvents,
  type SessionTraceEvent,
} from './session-events';

export type { SessionTraceEvent } from './session-events';

const EMPTY_EVENTS: SessionTraceEvent[] = [];

interface LiveEventState {
  sessionId: string | undefined;
  events: SessionTraceEvent[];
}

interface StreamErrorState {
  sessionId: string;
  message: string;
}

/** 退避等待也响应取消，关闭实时模式或卸载时不保留计时器。 */
function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * 历史快照交给 React Query，连接之后的事件暂存在本 Hook 中。UI 只消费合并结果，
 * 不需要知道分页、重连或去重细节；live 由页面控制，不在数据层另存一份开关。
 */
export function useSessionEvents(sessionId: string | undefined, live: boolean) {
  const queryClient = useQueryClient();
  const [liveState, setLiveState] = useState<LiveEventState>({ sessionId, events: [] });
  const [streamErrorState, setStreamErrorState] = useState<StreamErrorState | null>(null);

  const eventsQuery = useQuery({
    queryKey: ['sessions', sessionId, 'events'],
    queryFn: ({ signal }) =>
      loadSessionEventHistory(
        (query, pageSignal) => listSessionEvents(sessionId!, query, pageSignal),
        signal,
      ),
    enabled: sessionId !== undefined,
  });
  const history = eventsQuery.data?.data ?? EMPTY_EVENTS;
  const liveEvents = liveState.sessionId === sessionId ? liveState.events : EMPTY_EVENTS;
  const events = useMemo(() => mergeSessionEvents(history, liveEvents), [history, liveEvents]);

  useEffect(() => {
    setLiveState((current) => {
      if (current.sessionId !== sessionId) return current;
      const remaining = retainUnpersistedEvents(history, current.events);
      return remaining.length === current.events.length
        ? current
        : { ...current, events: remaining };
    });
  }, [history, sessionId]);

  useEffect(() => {
    if (!live || sessionId === undefined) return;
    const controller = new AbortController();
    const queryKey = ['sessions', sessionId, 'events'];
    let attempts = 0;

    // 不取消正在进行的历史读取，避免连续刷新让完整快照一直无法完成。
    const refreshSnapshot = () =>
      Promise.all([
        queryClient.invalidateQueries(
          { queryKey, exact: true },
          { cancelRefetch: false, throwOnError: true },
        ),
        queryClient.invalidateQueries(
          { queryKey: ['sessions', sessionId], exact: true },
          { cancelRefetch: false },
        ),
        queryClient.invalidateQueries(
          { queryKey: ['sessions', sessionId, 'files'] },
          { cancelRefetch: false },
        ),
      ]);

    const receiveEvent = (event: SessionTraceEvent) => {
      if (controller.signal.aborted) return;
      attempts = 0;
      const snapshot =
        queryClient.getQueryData<Page<PersistedEvent>>(queryKey)?.data ?? EMPTY_EVENTS;
      setLiveState((current) => {
        const previous = current.sessionId === sessionId ? current.events : EMPTY_EVENTS;
        const incoming = mergeSessionEvents([], [...previous, event]);
        return { sessionId, events: retainUnpersistedEvents(snapshot, incoming) };
      });
      // processed_at 回填不重广播，轮次结束后刷新历史才能恢复准确的处理时间。
      if (event.type === 'session.status_idle') {
        void refreshSnapshot().catch(() => undefined);
      } else if (event.type === 'session.status_running' || event.type === 'session.updated') {
        void queryClient.invalidateQueries(
          { queryKey: ['sessions', sessionId], exact: true },
          { cancelRefetch: false },
        );
      }
    };

    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          await refreshSnapshot();
          if (controller.signal.aborted) return;
          setStreamErrorState(null);
          await subscribeSessionEvents(sessionId, receiveEvent, controller.signal);
        } catch {
          // 补拉失败、断线或正常流结束，都由同一重连流程处理。
        }
        if (controller.signal.aborted) return;
        const delayMs = Math.min(1000 * 2 ** Math.min(attempts, 4), 15_000);
        attempts += 1;
        setStreamErrorState({
          sessionId,
          message: `实时事件连接断开，将在 ${Math.round(delayMs / 1000)} 秒后补拉历史并重新连接。`,
        });
        await waitForReconnect(delayMs, controller.signal);
      }
    };

    void connect();
    return () => controller.abort();
  }, [live, sessionId, queryClient]);

  const streamError =
    live && streamErrorState !== null && streamErrorState.sessionId === sessionId
      ? streamErrorState.message
      : null;
  return { events, eventsQuery, streamError };
}
