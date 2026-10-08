import type { Page, PersistedEvent, SessionEventListQuery, StreamEvent } from '@nano/shared/glm';

export type SessionTraceEvent = PersistedEvent | StreamEvent;

type RequestEventPage = (
  query: SessionEventListQuery,
  signal?: AbortSignal,
) => Promise<Page<PersistedEvent>>;

function eventId(event: SessionTraceEvent): string | null {
  return typeof event.id === 'string' ? event.id : null;
}

function hasProcessedTime(event: SessionTraceEvent): boolean {
  return typeof event.processed_at === 'string' && event.processed_at.length > 0;
}

/** 排队时间可以回填；其余字段不变，因此完整版本优先，其次使用指定的首选来源。 */
function preferCompleteEvent<T extends SessionTraceEvent>(preferred: T, fallback: T): T {
  return !hasProcessedTime(preferred) && hasProcessedTime(fallback) ? fallback : preferred;
}

/** 按事件第一次出现的位置去重，不按时间重新排序；实时重复帧允许更新已有事件。 */
function deduplicateEvents<T extends SessionTraceEvent>(events: readonly T[]): T[] {
  const result: T[] = [];
  const indexById = new Map<string, number>();
  for (const event of events) {
    const id = eventId(event);
    const index = id === null ? undefined : indexById.get(id);
    if (index !== undefined) {
      result[index] = preferCompleteEvent(event, result[index]!);
      continue;
    }
    if (id !== null) indexById.set(id, result.length);
    result.push(event);
  }
  return result;
}

/**
 * 历史保留接口顺序，实时事件追加在其后。历史版本通常更完整，唯独尚未回填的
 * processed_at 不应覆盖实时流中的已处理版本。无 id 的流帧保持各自独立。
 */
export function mergeSessionEvents(
  history: readonly SessionTraceEvent[],
  live: readonly SessionTraceEvent[],
): SessionTraceEvent[] {
  const result = deduplicateEvents(history);
  const indexById = new Map<string, number>();
  result.forEach((event, index) => {
    const id = eventId(event);
    if (id !== null) indexById.set(id, index);
  });

  for (const event of deduplicateEvents(live)) {
    const id = eventId(event);
    const index = id === null ? undefined : indexById.get(id);
    if (index !== undefined) {
      result[index] = preferCompleteEvent(result[index]!, event);
    } else {
      result.push(event);
    }
  }
  return result;
}

/** 已由历史接管的实时事件可以释放；历史仍然排队、实时已经完成的版本继续保留。 */
export function retainUnpersistedEvents(
  history: readonly SessionTraceEvent[],
  live: readonly SessionTraceEvent[],
): SessionTraceEvent[] {
  const historyById = new Map<string, SessionTraceEvent>();
  for (const event of history) {
    const id = eventId(event);
    if (id !== null) historyById.set(id, event);
  }
  return live.filter((event) => {
    const id = eventId(event);
    const historical = id === null ? undefined : historyById.get(id);
    return historical === undefined || (!hasProcessedTime(historical) && hasProcessedTime(event));
  });
}

/**
 * 从最早事件开始读取全部分页，保留服务端的序号顺序。一次成功后提交完整快照，
 * 重新拉取期间 React Query 继续保留上一份数据，不会让 Trace 短暂消失。
 * 请求函数通过参数传入，分页协议可以脱离 React 和浏览器独立测试。
 */
export async function loadSessionEventHistory(
  requestPage: RequestEventPage,
  signal?: AbortSignal,
): Promise<Page<PersistedEvent>> {
  const events: PersistedEvent[] = [];
  const visitedCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    signal?.throwIfAborted();
    const page = await requestPage(
      { order: 'asc', limit: 100, ...(cursor === undefined ? {} : { page: cursor }) },
      signal,
    );
    signal?.throwIfAborted();
    events.push(...page.data);
    if (page.next_page === null) break;
    if (visitedCursors.has(page.next_page)) {
      throw new Error('Session event pagination returned a repeated cursor.');
    }
    visitedCursors.add(page.next_page);
    cursor = page.next_page;
  }

  return { data: deduplicateEvents(events), next_page: null };
}
