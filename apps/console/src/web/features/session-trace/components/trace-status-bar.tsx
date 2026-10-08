import type { Session } from '@nano/shared/glm';
import { Clock3, Database, Gauge } from 'lucide-react';
import { formatNumber } from '@/lib/format';
import type { LedgerRecord } from '@/lib/session-ledger';

export function TraceStatusBar({
  session,
  records,
}: {
  session: Session;
  records: readonly LedgerRecord[];
}) {
  const turns = new Set(
    records.filter((record) => record.kind === 'user').map((record) => record.turn),
  ).size;
  const steps = new Set(
    records.filter((record) => record.step > 0).map((record) => `${record.turn}:${record.step}`),
  ).size;
  const {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cached,
  } = session.usage;
  const cachePercent = input > 0 ? Math.min(100, Math.round((cached / input) * 100)) : 0;
  const throughput =
    session.stats.active_seconds > 0 ? output / session.stats.active_seconds : null;
  return (
    <section className="trace-status-bar" aria-label="会话统计">
      <span title="会话输出 Token 数除以活跃时长">
        <Gauge aria-hidden /> {turns} 轮 {steps} 步
        {throughput !== null ? ` · ${throughput.toFixed(1)} tok/s` : ''}
      </span>
      <span title={`输入 ${formatNumber(input)} tokens，输出 ${formatNumber(output)} tokens`}>
        <Database aria-hidden /> {formatNumber(input + output)} tok · 缓存命中 {cachePercent}%
      </span>
      <span title="会话活跃时长">
        <Clock3 aria-hidden /> {session.stats.active_seconds.toFixed(1)}s
      </span>
    </section>
  );
}
