import type { Session } from '@nano/shared/glm';
import {
  buildLedger,
  formatSpanDuration,
  type LedgerLane,
  type LedgerRecord,
} from '../../../lib/session-ledger';
import type { SessionTraceEvent } from './session-events';

function systemMessageText(event: SessionTraceEvent): string | undefined {
  const content = event.content ?? event.text ?? event.message;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return undefined;
  return content
    .flatMap((block) =>
      typeof block === 'object' && block !== null && typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('\n')
    .trim();
}

/** Keep API order: processed_at can change after a queued event has already been stored. */
export function buildTraceRecords(
  events: readonly SessionTraceEvent[],
  systemPrompt: Session['agent']['system'],
): LedgerRecord[] {
  const source: Record<string, unknown>[] = [...events];
  const hasSystemPrompt = events.some(
    (event) =>
      event.type === 'system.message' &&
      (event.source === 'agent.system' || systemMessageText(event) === systemPrompt?.trim()),
  );
  if (systemPrompt && !hasSystemPrompt) {
    source.unshift({
      id: 'session-system-prompt',
      type: 'system.message',
      source: 'agent.system',
      content: systemPrompt,
    });
  }
  return buildLedger(source);
}

/** Agent 的系统提示属于配置，没有排队状态或执行耗时。 */
export function getTraceRecordStatus(record: LedgerRecord): string {
  if (record.raw.source === 'agent.system') return '配置';
  if (record.isError) return '失败';
  if (record.startedAt === null) return '排队中';
  return record.endAt === null ? '进行中' : '已完成';
}

export function getTraceDurationLabel(record: LedgerRecord): string {
  if (record.raw.source === 'agent.system') return '不适用';
  return record.durationMs === null ? '未提供' : formatSpanDuration(record.durationMs);
}

/** 结束事件优先，未提供时回到开始事件；兼容两种请求选项字段名。 */
export function getTraceRequestOptions(record: LedgerRecord): unknown {
  return (
    record.raw.options ??
    record.startRaw?.options ??
    record.raw.request_options ??
    record.startRaw?.request_options
  );
}

function searchText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined ? '' : JSON.stringify(value);
}

/** Search full payloads, including paired tool output, rather than the truncated row summary. */
export function findTraceMatches(
  records: readonly LedgerRecord[],
  events: readonly SessionTraceEvent[],
  search: string,
): ReadonlySet<string> | null {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return null;
  const outputByCall = new Map<string, string>();
  for (const event of events) {
    const payload = event as Record<string, unknown>;
    if (typeof payload.tool_use_id === 'string' && String(payload.type).endsWith('tool_result')) {
      outputByCall.set(payload.tool_use_id, searchText(payload.content));
    }
  }
  return new Set(
    records
      .filter((record) =>
        [
          record.key,
          record.summary,
          searchText(record.raw),
          searchText(record.startRaw),
          outputByCall.get(record.key) ?? '',
        ]
          .join('\n')
          .toLocaleLowerCase()
          .includes(query),
      )
      .map((record) => record.key),
  );
}

export function filterTraceRecords(
  records: readonly LedgerRecord[],
  lane: LedgerLane | 'all',
  matches: ReadonlySet<string> | null,
): LedgerRecord[] {
  return records.filter(
    (record) =>
      (lane === 'all' || record.lane === lane) && (matches === null || matches.has(record.key)),
  );
}
