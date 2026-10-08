import { Badge } from '@/components/ui/badge';
import type { LedgerKind, LedgerRecord } from '@/lib/session-ledger';

export type TraceTone = 'user' | 'context' | 'assistant' | 'tool' | 'system' | 'error' | 'request';

export interface TraceLabelValue {
  label: string;
  tone: TraceTone;
}

const LABEL_BY_KIND: Record<LedgerKind, TraceLabelValue> = {
  user: { label: '用户', tone: 'user' },
  system: { label: '系统', tone: 'system' },
  message: { label: '助手', tone: 'assistant' },
  thinking: { label: '助手', tone: 'assistant' },
  tool: { label: '工具', tone: 'tool' },
  error: { label: '错误', tone: 'error' },
  span: { label: '请求', tone: 'request' },
};

/** Labels describe the record's role; failures keep their own error color. */
export function getTraceLabel(record: LedgerRecord): TraceLabelValue {
  if (record.isError) {
    return { label: record.kind === 'tool' ? '工具' : '错误', tone: 'error' };
  }
  if (record.raw.source === 'agent.system') return LABEL_BY_KIND.system;
  if (
    record.kind === 'system' &&
    (record.raw.type === 'agent.thread_context_compacted' || record.raw.type === 'system.message')
  ) {
    return { label: '上下文', tone: 'context' };
  }
  return LABEL_BY_KIND[record.kind];
}

export function TraceLabel({ record }: { record: LedgerRecord }) {
  const { label, tone } = getTraceLabel(record);
  return (
    <Badge variant="ghost" className="trace-label" data-tone={tone}>
      {label}
    </Badge>
  );
}
