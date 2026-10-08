// biome-ignore-all lint/a11y/useSemanticElements: Virtualized grid rows and cells use absolute positioning.
import { memo } from 'react';
import { formatSpanDuration, type LedgerRecord, type LedgerRow } from '@/lib/session-ledger';
import { cn } from '@/lib/utils';
import { TRACE_ROW_HEIGHT } from '../data/trace-rows';
import { TraceLabel } from './trace-label';

function TraceDuration({ record }: { record: LedgerRecord }) {
  const text =
    record.raw.source === 'agent.system'
      ? '—'
      : record.startedAt === null
        ? '排队中'
        : record.durationMs === null || record.endAt === null
          ? '进行中'
          : record.durationMs > 0
            ? formatSpanDuration(record.durationMs)
            : '—';
  return <span className="trace-row-duration">{text}</span>;
}

function hasTextSelection(): boolean {
  return (window.getSelection()?.toString().length ?? 0) > 0;
}

export interface TraceRowProps {
  row: LedgerRow;
  index: number;
  id: string;
  top: number;
  selected: boolean;
  keyboardActive: boolean;
  outsideFocus: boolean;
  showDuration: boolean;
  groupTurns: boolean;
  stepCollapsible: boolean;
  stepCollapsed: boolean;
  onActivate: (row: LedgerRow) => void;
  onToggleTurn: (turn: number) => void;
  onToggleStep: (turn: number, step: number) => void;
}

export const TraceRow = memo(function TraceRow({
  row,
  index,
  id,
  top,
  selected,
  keyboardActive,
  outsideFocus,
  showDuration,
  groupTurns,
  stepCollapsible,
  stepCollapsed,
  onActivate,
  onToggleTurn,
  onToggleStep,
}: TraceRowProps) {
  const { record, collapsed } = row;
  const request = record?.kind === 'span';
  const turn = record?.turn ?? collapsed?.turn;
  const summary = record?.summary ?? collapsed?.text ?? '';
  return (
    <div
      id={id}
      role="row"
      tabIndex={-1}
      aria-rowindex={index + 1}
      aria-selected={selected}
      data-row-key={row.key}
      data-timeline-focus={outsideFocus ? 'outside' : undefined}
      data-keyboard-active={keyboardActive || undefined}
      data-request={request || undefined}
      className={cn(
        'trace-row',
        selected && 'trace-row-selected',
        outsideFocus && 'trace-row-outside-focus',
        record?.isError && 'trace-row-error',
      )}
      style={{ position: 'absolute', top, height: TRACE_ROW_HEIGHT, width: '100%' }}
      title={request ? `${record.label} · 第 ${record.turn} 轮` : summary}
      onClick={(event) => {
        if (hasTextSelection()) return;
        event.currentTarget.closest<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true });
        onActivate(row);
      }}
      onDoubleClick={() => {
        if (record && groupTurns) onToggleTurn(record.turn);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        onActivate(row);
      }}
    >
      <div role="gridcell" tabIndex={-1} className="trace-turn-rail">
        {groupTurns && record?.raw.source !== 'agent.system' ? (
          <span
            aria-hidden
            className="trace-turn-line"
            data-turn-start={row.turnStart || undefined}
            data-turn-end={row.turnEnd || undefined}
          />
        ) : null}
        {groupTurns && row.turnStart && turn !== undefined ? (
          <button
            type="button"
            tabIndex={-1}
            className="trace-turn-marker"
            aria-label={`折叠或展开第 ${turn} 轮`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleTurn(turn);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            第 {turn} 轮
          </button>
        ) : null}
        {request ? <span aria-hidden className="trace-request-dot" /> : null}
      </div>
      <div role="gridcell" tabIndex={-1} className="trace-row-content">
        {record && !request ? <TraceLabel record={record} /> : null}
        <span
          className={cn(
            'trace-row-summary truncate',
            record?.kind === 'tool' && 'trace-tool-summary',
            collapsed && 'trace-collapsed-summary',
            request && 'sr-only',
          )}
        >
          {summary}
        </span>
        {record && stepCollapsible ? (
          <button
            type="button"
            tabIndex={-1}
            className="trace-step-toggle"
            aria-expanded={!stepCollapsed}
            aria-label={`${stepCollapsed ? '展开' : '折叠'}第 ${record.turn} 轮第 ${record.step} 步的工具调用`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleStep(record.turn, record.step);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {stepCollapsed ? '展开调用' : '折叠调用'}
          </button>
        ) : null}
      </div>
      {showDuration ? (
        <div role="gridcell" tabIndex={-1} className="trace-duration-cell">
          {record ? <TraceDuration record={record} /> : null}
        </div>
      ) : null}
    </div>
  );
});
