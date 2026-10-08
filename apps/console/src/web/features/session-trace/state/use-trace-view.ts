import { useDeferredValue, useMemo, useReducer } from 'react';
import type { TimelineRange } from '@/lib/session-ledger';
import { collapsibleSteps, deriveTimelineSpans, timelineFocusKeys } from '@/lib/session-ledger';
import { buildTraceRecords, filterTraceRecords, findTraceMatches } from '../data/trace-view-model';
import type { SessionTraceEvent } from '../data/use-session-events';
import { INITIAL_TRACE_VIEW, traceViewReducer } from './trace-view-state';

export function useTraceView(events: readonly SessionTraceEvent[], systemPrompt: string | null) {
  const [state, dispatch] = useReducer(traceViewReducer, INITIAL_TRACE_VIEW);
  const search = useDeferredValue(state.search);
  const records = useMemo(() => buildTraceRecords(events, systemPrompt), [events, systemPrompt]);
  const recordByKey = useMemo(
    () => new Map(records.map((record) => [record.key, record])),
    [records],
  );
  const searchMatches = useMemo(
    () => findTraceMatches(records, events, search),
    [records, events, search],
  );
  const visibleRecords = useMemo(
    () => filterTraceRecords(records, state.lane, searchMatches),
    [records, state.lane, searchMatches],
  );
  const timeline = useMemo(() => deriveTimelineSpans(records, state.mode), [records, state.mode]);
  const focusKeys = useMemo(
    () => (timeline && state.range ? timelineFocusKeys(timeline, state.range) : null),
    [timeline, state.range],
  );
  const toolSteps = useMemo(() => collapsibleSteps(visibleRecords), [visibleRecords]);
  const selectedRecord = state.selectedKey ? (recordByKey.get(state.selectedKey) ?? null) : null;

  function selectRecord(key: string) {
    const record = recordByKey.get(key);
    if (!record) return;
    dispatch({ type: 'select', record, revealFiltered: !visibleRecords.includes(record) });
  }

  function selectRange(range: TimelineRange | null) {
    const keys = timeline && range ? timelineFocusKeys(timeline, range) : null;
    dispatch({
      type: 'range',
      value: range,
      revealRecords: keys ? records.filter((record) => keys.has(record.key)) : [],
    });
  }

  return {
    state,
    dispatch,
    records,
    visibleRecords,
    timeline,
    focusKeys,
    searchMatches,
    toolSteps,
    selectedRecord,
    selectRecord,
    selectRange,
  };
}
