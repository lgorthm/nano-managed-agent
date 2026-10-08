import type { Session } from '@nano/shared/glm';
import type { ReactNode } from 'react';
import { formatNumber, formatTime } from '@/lib/format';
import { formatSpanDuration, type LedgerRecord } from '@/lib/session-ledger';
import { getTraceDurationLabel, getTraceRecordStatus } from '../data/trace-view-model';
import { getEventContent, InspectorEmpty, InspectorJson, TraceContent } from './trace-content';

export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="trace-inspector-section">
      <h3 className="trace-inspector-section-title">{title}</h3>
      {children}
    </section>
  );
}

interface InspectorField {
  label: string;
  value: ReactNode;
}

export function InspectorFields({ fields }: { fields: readonly InspectorField[] }) {
  return (
    <dl className="trace-inspector-fields">
      {fields.map(({ label, value }) => (
        <div className="trace-inspector-field" key={label}>
          <dt className="trace-inspector-label">{label}</dt>
          <dd className="trace-inspector-value">{value ?? '未提供'}</dd>
        </div>
      ))}
    </dl>
  );
}

const traceTimeFormatter = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hour12: false,
});

function traceTimeValue(timestamp: number | null): string {
  return timestamp === null ? '未提供' : traceTimeFormatter.format(timestamp);
}

function sourceValue(raw: Record<string, unknown>): ReactNode {
  if (typeof raw.request_id === 'string') return `请求 ${raw.request_id}`;
  if (typeof raw.source === 'string') return raw.source;
  return typeof raw.type === 'string' ? raw.type : '未提供';
}

export function MessageOverview({ record }: { record: LedgerRecord }) {
  return (
    <>
      <InspectorFields
        fields={[
          { label: '来源', value: sourceValue(record.raw) },
          { label: '状态', value: getTraceRecordStatus(record) },
          { label: '耗时', value: getTraceDurationLabel(record) },
        ]}
      />
      <InspectorSection title={record.kind === 'thinking' ? '思考' : '预览'}>
        <TraceContent value={getEventContent(record.raw)} />
      </InspectorSection>
    </>
  );
}

/** 来源字段只显示事件实际提供的身份和关联，不推断不存在的请求编号。 */
export function MessageSource({ record }: { record: LedgerRecord }) {
  const raw = record.raw;
  const fields: InspectorField[] = [
    { label: '事件类型', value: typeof raw.type === 'string' ? raw.type : '未提供' },
    { label: '事件 ID', value: typeof raw.id === 'string' ? raw.id : record.eventId },
    {
      label: '创建时间',
      value: formatTime(typeof raw.created_at === 'string' ? raw.created_at : null),
    },
    {
      label: '处理时间',
      value: formatTime(typeof raw.processed_at === 'string' ? raw.processed_at : null),
    },
  ];

  const sourceFields = [
    ['来源', 'source'],
    ['请求 ID', 'request_id'],
    ['线程 ID', 'thread_id'],
    ['父事件 ID', 'parent_id'],
  ] as const;
  for (const [label, key] of sourceFields) {
    if (typeof raw[key] === 'string') fields.push({ label, value: raw[key] });
  }

  return <InspectorFields fields={fields} />;
}

export function ToolOverview({
  record,
  result,
}: {
  record: LedgerRecord;
  result: Record<string, unknown> | undefined;
}) {
  return (
    <>
      <InspectorFields
        fields={[
          {
            label: '工具',
            value:
              record.toolName ??
              (typeof record.raw.name === 'string' ? record.raw.name : undefined),
          },
          { label: '来源', value: sourceValue(record.raw) },
          { label: '状态', value: getTraceRecordStatus(record) },
          { label: '耗时', value: getTraceDurationLabel(record) },
        ]}
      />
      <InspectorSection title="参数">
        <InspectorJson value={record.raw.input} />
      </InspectorSection>
      <InspectorSection title="结果预览">
        <TraceContent
          value={result ? getEventContent(result) : undefined}
          emptyMessage="尚未收到工具结果。"
        />
      </InspectorSection>
    </>
  );
}

export function ToolSchema({ record, session }: { record: LedgerRecord; session: Session }) {
  const name = record.toolName ?? record.raw.name;
  const tool = session.agent?.tools.find(
    (candidate) => candidate.type === 'custom' && candidate.name === name,
  );
  if (tool?.type !== 'custom') {
    return <InspectorEmpty>会话的工具配置未提供此工具的参数 Schema。</InspectorEmpty>;
  }

  return (
    <>
      <InspectorSection title={tool.name}>
        <p className="trace-inspector-text">{tool.description}</p>
      </InspectorSection>
      <InspectorSection title="参数">
        <InspectorJson value={tool.input_schema} />
      </InspectorSection>
    </>
  );
}

export function InspectorTiming({ record }: { record: LedgerRecord }) {
  const raw = record.raw;
  const fields: InspectorField[] = [
    {
      label: '开始时间',
      value: traceTimeValue(record.startedAt),
    },
    {
      label: '结束时间',
      value: traceTimeValue(record.endAt),
    },
    { label: '总时长', value: getTraceDurationLabel(record) },
  ];

  // 这些可选字段由事件携带；没有首 token 或生成计时时不会推算并冒充测量值。
  const timingFields = [
    ['首 token 延迟', 'time_to_first_token_ms'],
    ['生成时长', 'generation_duration_ms'],
  ] as const;
  for (const [label, key] of timingFields) {
    if (typeof raw[key] === 'number') fields.push({ label, value: formatSpanDuration(raw[key]) });
  }

  return (
    <InspectorSection title={record.kind === 'tool' ? '工具计时' : '请求计时'}>
      <InspectorFields fields={fields} />
      {raw.timing ? <InspectorJson value={raw.timing} /> : null}
    </InspectorSection>
  );
}

export function RequestOverview({ record }: { record: LedgerRecord }) {
  const raw = record.raw;
  const model = typeof raw.model === 'string' ? raw.model : undefined;
  return (
    <>
      <InspectorFields
        fields={[
          { label: '来源', value: sourceValue(raw) },
          { label: '状态', value: getTraceRecordStatus(record) },
          { label: '耗时', value: getTraceDurationLabel(record) },
          ...(model ? [{ label: '模型', value: model }] : []),
        ]}
      />
      <InspectorSection title="请求计时">
        <InspectorFields
          fields={[
            {
              label: '开始时间',
              value: traceTimeValue(record.startedAt),
            },
            { label: '总时长', value: getTraceDurationLabel(record) },
          ]}
        />
      </InspectorSection>
    </>
  );
}

const TOKEN_LABELS: Record<string, string> = {
  input_tokens: '输入',
  prompt_tokens: '输入（prompt）',
  cached_tokens: '缓存读取（cached）',
  cache_read_input_tokens: '缓存读取',
  cache_creation_input_tokens: '缓存写入',
  output_tokens: '输出',
  completion_tokens: '输出（completion）',
  total_tokens: '合计',
};

function TokenUsage({ usage }: { usage: Record<string, unknown> }) {
  const entries = Object.entries(usage);
  const isTokenCount = (key: string, value: unknown) =>
    key.endsWith('_tokens') && typeof value === 'number';
  const tokenFields = entries
    .filter(([key, value]) => isTokenCount(key, value))
    .map(([key, value]) => ({
      label: TOKEN_LABELS[key] ?? key,
      value: `${formatNumber(value as number)} tok`,
    }));
  const additionalFields = entries.filter(([key, value]) => !isTokenCount(key, value));

  return (
    <>
      {tokenFields.length > 0 ? <InspectorFields fields={tokenFields} /> : null}
      {additionalFields.length > 0 ? (
        <InspectorJson value={Object.fromEntries(additionalFields)} />
      ) : null}
    </>
  );
}

export function RequestUsage({ record, session }: { record: LedgerRecord; session: Session }) {
  const usage = record.raw.usage;
  const requestUsage =
    typeof usage === 'object' && usage !== null && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : undefined;

  return (
    <>
      <InspectorSection title="本次请求">
        {requestUsage && Object.keys(requestUsage).length > 0 ? (
          <TokenUsage usage={requestUsage} />
        ) : (
          <InspectorEmpty>此请求事件未提供 Token 用量。</InspectorEmpty>
        )}
      </InspectorSection>
      <InspectorSection title="会话累计">
        <TokenUsage usage={session.usage} />
      </InspectorSection>
    </>
  );
}
