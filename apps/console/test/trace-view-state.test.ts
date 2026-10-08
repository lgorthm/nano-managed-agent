import { describe, expect, it } from 'vitest';
import {
  INITIAL_TRACE_VIEW,
  traceViewReducer,
} from '../src/web/features/session-trace/state/trace-view-state';
import type { LedgerRecord } from '../src/web/lib/session-ledger';

const tool: LedgerRecord = {
  key: 'tool-1',
  eventId: 'tool-1',
  lane: 'tool',
  kind: 'tool',
  label: '工具调用',
  summary: 'bash',
  startedAt: 10,
  endAt: 20,
  durationMs: 10,
  isError: false,
  turn: 2,
  step: 3,
  raw: { type: 'agent.tool_use', name: 'bash', input: {} },
};

describe('Trace selection transitions', () => {
  it('selecting a hidden timeline item clears filters and reveals its folded turn and step together', () => {
    const previous = {
      ...INITIAL_TRACE_VIEW,
      lane: 'input' as const,
      search: 'unrelated',
      collapsedTurns: new Set([1, 2]),
      collapsedSteps: new Set(['1:1', '2:3']),
    };
    const next = traceViewReducer(previous, { type: 'select', record: tool, revealFiltered: true });
    expect(next.selectedKey).toBe('tool-1');
    expect(next.lane).toBe('all');
    expect(next.search).toBe('');
    expect([...next.collapsedTurns]).toEqual([1]);
    expect([...next.collapsedSteps]).toEqual(['1:1']);
    expect([...previous.collapsedTurns]).toEqual([1, 2]);
    expect([...previous.collapsedSteps]).toEqual(['1:1', '2:3']);
  });

  it('selecting a visible item preserves the user search and lane', () => {
    const next = traceViewReducer(
      { ...INITIAL_TRACE_VIEW, lane: 'tool', search: 'bash' },
      { type: 'select', record: tool, revealFiltered: false },
    );
    expect(next.lane).toBe('tool');
    expect(next.search).toBe('bash');
  });

  it('selecting the same record again still requests navigation after a row was hidden', () => {
    const first = traceViewReducer(INITIAL_TRACE_VIEW, {
      type: 'select',
      record: tool,
      revealFiltered: false,
    });
    const second = traceViewReducer(first, { type: 'select', record: tool, revealFiltered: true });
    expect(second.selectionRevision).toBe(first.selectionRevision + 1);
  });

  it('changing projection clears a range whose coordinates belong to the previous projection', () => {
    const next = traceViewReducer(
      { ...INITIAL_TRACE_VIEW, selectedKey: tool.key, range: { start: 2, end: 4 } },
      { type: 'mode', value: 'duration' },
    );
    expect(next.mode).toBe('duration');
    expect(next.range).toBeNull();
    expect(next.selectedKey).toBe(tool.key);
  });

  it('a timeline range reveals folded records without changing the current search', () => {
    const next = traceViewReducer(
      {
        ...INITIAL_TRACE_VIEW,
        search: 'bash',
        collapsedTurns: new Set([2]),
        collapsedSteps: new Set(['2:3']),
      },
      { type: 'range', value: { start: 10, end: 20 }, revealRecords: [tool] },
    );
    expect(next.range).toEqual({ start: 10, end: 20 });
    expect(next.search).toBe('bash');
    expect(next.collapsedTurns.size).toBe(0);
    expect(next.collapsedSteps.size).toBe(0);
  });

  it('a call visibility toggle expands partial groups consistently and preserves turn folds', () => {
    const state = {
      ...INITIAL_TRACE_VIEW,
      collapsedSteps: new Set(['1:1']),
      collapsedTurns: new Set([3]),
    };
    const closed = traceViewReducer(state, {
      type: 'toggle-calls',
      steps: new Set(['1:1', '2:3']),
    });
    const opened = traceViewReducer(closed, {
      type: 'toggle-calls',
      steps: new Set(['1:1', '2:3']),
    });
    expect([...closed.collapsedSteps]).toEqual(['1:1', '2:3']);
    expect(opened.collapsedSteps.size).toBe(0);
    expect([...opened.collapsedTurns]).toEqual([3]);
  });
});
