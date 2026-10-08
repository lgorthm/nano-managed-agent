// biome-ignore-all lint/a11y/useSemanticElements: The virtualized ARIA grid uses absolutely positioned rows and one active-descendant keyboard focus.
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  forwardRef,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { collapsibleSteps, type LedgerRecord, type LedgerRow, stepKey } from '@/lib/session-ledger';
import { cn } from '@/lib/utils';
import { buildTraceRows, TRACE_COMPOSER_CLEARANCE, TRACE_ROW_HEIGHT } from '../data/trace-rows';
import { TraceRow } from './trace-row';

export interface TraceListHandle {
  scrollToKey(key: string): void;
  scrollToFocus(keys: ReadonlySet<string>): void;
  jumpToTail(): void;
}

export interface TraceListProps {
  records: LedgerRecord[];
  selectedKey: string | null;
  focusKeys: ReadonlySet<string> | null;
  showDuration: boolean;
  groupTurns: boolean;
  collapsedTurns: ReadonlySet<number>;
  collapsedSteps: ReadonlySet<string>;
  onSelect: (key: string) => void;
  onToggleTurn: (turn: number) => void;
  onToggleStep: (turn: number, step: number) => void;
  /** Use the unfiltered ledger's tail key so filtering cannot resume live scrolling. */
  liveTailKey?: string | null;
  className?: string;
}

export const TraceList = forwardRef<TraceListHandle, TraceListProps>(function TraceList(
  {
    records,
    selectedKey,
    focusKeys,
    showDuration,
    groupTurns,
    collapsedTurns,
    collapsedSteps,
    onSelect,
    onToggleTurn,
    onToggleStep,
    liveTailKey = null,
    className,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToTail = useRef(true);
  const observedTail = useRef<string | null | undefined>(undefined);
  const [keyboardCursor, setKeyboardCursor] = useState<{
    key: string;
    selectionKey: string | null;
  } | null>(null);
  const idPrefix = useId();
  const rows = useMemo(
    () => buildTraceRows(records, groupTurns, collapsedTurns, collapsedSteps),
    [records, groupTurns, collapsedTurns, collapsedSteps],
  );
  const rowIndexByKey = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const collapsibleStepKeys = useMemo(() => collapsibleSteps(records), [records]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: () => TRACE_ROW_HEIGHT,
    overscan: 12,
    paddingEnd: TRACE_COMPOSER_CLEARANCE,
  });

  const jumpToTail = () => {
    pinnedToTail.current = true;
    virtualizer.scrollToOffset(virtualizer.getTotalSize());
  };

  useImperativeHandle(ref, () => ({
    scrollToKey(key) {
      const index = rowIndexByKey.get(key);
      if (index === undefined) return;
      pinnedToTail.current = false;
      virtualizer.scrollToIndex(index, { align: 'center' });
    },
    scrollToFocus(keys) {
      let first = -1;
      let last = -1;
      rows.forEach((row, index) => {
        if (row.record && keys.has(row.record.key)) {
          if (first === -1) first = index;
          last = index;
        }
      });
      if (first === -1) return;
      pinnedToTail.current = false;
      const focusedHeight = (last - first + 1) * TRACE_ROW_HEIGHT;
      virtualizer.scrollToIndex(first, {
        align: focusedHeight > (scrollRef.current?.clientHeight ?? 0) ? 'start' : 'center',
      });
    },
    jumpToTail,
  }));

  useEffect(() => {
    if (observedTail.current === liveTailKey) return;
    observedTail.current = liveTailKey;
    if (pinnedToTail.current && rows.length > 0) {
      virtualizer.scrollToOffset(virtualizer.getTotalSize());
    }
  }, [liveTailKey, rows.length, virtualizer]);

  const activateRow = useCallback(
    (row: LedgerRow) => {
      setKeyboardCursor({ key: row.key, selectionKey: selectedKey });
      pinnedToTail.current = false;
      if (row.collapsed?.kind === 'turn') onToggleTurn(row.collapsed.turn);
      else if (row.collapsed?.kind === 'step') {
        onToggleStep(row.collapsed.turn, row.collapsed.step);
      } else if (row.record) onSelect(row.record.key);
    },
    [onSelect, onToggleTurn, onToggleStep, selectedKey],
  );

  const activeKey =
    keyboardCursor?.selectionKey === selectedKey && rowIndexByKey.has(keyboardCursor.key)
      ? keyboardCursor.key
      : selectedKey;
  const activeIndex = activeKey === null ? undefined : rowIndexByKey.get(activeKey);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLButtonElement && ['Enter', ' '].includes(event.key)) return;
    if (rows.length === 0) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const row = rows[activeIndex ?? 0];
      if (row) activateRow(row);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : Math.min(
              rows.length - 1,
              Math.max(0, (activeIndex ?? -1) + (event.key === 'ArrowDown' ? 1 : -1)),
            );
    const row = rows[nextIndex];
    if (!row) return;
    pinnedToTail.current = false;
    setKeyboardCursor({ key: row.key, selectionKey: selectedKey });
    virtualizer.scrollToIndex(nextIndex, { align: 'auto' });
  };

  const virtualItems = virtualizer.getVirtualItems();
  const activeRowVisible = virtualItems.some((item) => item.index === activeIndex);
  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-label="Trace 记录。使用上下方向键浏览，按 Enter 选择记录。"
      aria-rowcount={rows.length}
      aria-colcount={showDuration ? 3 : 2}
      aria-activedescendant={activeRowVisible ? `${idPrefix}-row-${activeIndex}` : undefined}
      className={cn('trace-list', className)}
      onKeyDown={onKeyDown}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinnedToTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      <div
        role="rowgroup"
        className="trace-list-canvas trace-list-padding"
        style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
      >
        {virtualItems.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const { record } = row;
          const step = record ? stepKey(record.turn, record.step) : '';
          return (
            <TraceRow
              key={item.key}
              row={row}
              index={item.index}
              id={`${idPrefix}-row-${item.index}`}
              top={item.start}
              selected={record?.key === selectedKey}
              keyboardActive={item.index === activeIndex}
              outsideFocus={focusKeys !== null && !(record && focusKeys.has(record.key))}
              showDuration={showDuration}
              groupTurns={groupTurns}
              stepCollapsible={
                !!record &&
                (record.kind === 'message' || record.kind === 'thinking') &&
                collapsibleStepKeys.has(step)
              }
              stepCollapsed={collapsedSteps.has(step)}
              onActivate={activateRow}
              onToggleTurn={onToggleTurn}
              onToggleStep={onToggleStep}
            />
          );
        })}
      </div>
    </div>
  );
});
