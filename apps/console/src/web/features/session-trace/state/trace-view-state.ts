import type {
  LedgerLane,
  LedgerRecord,
  TimelineMode,
  TimelineRange,
} from '../../../lib/session-ledger';
import { stepKey } from '../../../lib/session-ledger';

export interface TraceViewState {
  selectedKey: string | null;
  selectionRevision: number;
  search: string;
  lane: LedgerLane | 'all';
  mode: TimelineMode;
  range: TimelineRange | null;
  showDuration: boolean;
  groupTurns: boolean;
  collapsedTurns: ReadonlySet<number>;
  collapsedSteps: ReadonlySet<string>;
}

export const INITIAL_TRACE_VIEW: TraceViewState = {
  selectedKey: null,
  selectionRevision: 0,
  search: '',
  lane: 'all',
  mode: 'sequence',
  range: null,
  showDuration: false,
  groupTurns: true,
  collapsedTurns: new Set(),
  collapsedSteps: new Set(),
};

export type TraceViewAction =
  | { type: 'select'; record: LedgerRecord; revealFiltered: boolean }
  | { type: 'close-detail' }
  | { type: 'search'; value: string }
  | { type: 'lane'; value: TraceViewState['lane'] }
  | { type: 'mode'; value: TimelineMode }
  | { type: 'range'; value: TimelineRange | null; revealRecords?: readonly LedgerRecord[] }
  | { type: 'toggle-duration' }
  | { type: 'toggle-turn-groups' }
  | { type: 'toggle-turn'; turn: number }
  | { type: 'toggle-step'; turn: number; step: number }
  | { type: 'toggle-calls'; steps: ReadonlySet<string> };

function toggled<T>(values: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(values);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** Selection reveals its row in one transition, so list and timeline always agree. */
export function traceViewReducer(state: TraceViewState, action: TraceViewAction): TraceViewState {
  switch (action.type) {
    case 'select': {
      const collapsedTurns = new Set(state.collapsedTurns);
      const collapsedSteps = new Set(state.collapsedSteps);
      collapsedTurns.delete(action.record.turn);
      collapsedSteps.delete(stepKey(action.record.turn, action.record.step));
      return {
        ...state,
        selectedKey: action.record.key,
        selectionRevision: state.selectionRevision + 1,
        collapsedTurns,
        collapsedSteps,
        ...(action.revealFiltered ? { lane: 'all' as const, search: '' } : {}),
      };
    }
    case 'close-detail':
      return { ...state, selectedKey: null };
    case 'search':
      return { ...state, search: action.value };
    case 'lane':
      return { ...state, lane: action.value };
    case 'mode':
      return { ...state, mode: action.value, range: null };
    case 'range': {
      if (!action.revealRecords?.length) return { ...state, range: action.value };
      const collapsedTurns = new Set(state.collapsedTurns);
      const collapsedSteps = new Set(state.collapsedSteps);
      for (const record of action.revealRecords) {
        collapsedTurns.delete(record.turn);
        collapsedSteps.delete(stepKey(record.turn, record.step));
      }
      return { ...state, range: action.value, collapsedTurns, collapsedSteps };
    }
    case 'toggle-duration':
      return { ...state, showDuration: !state.showDuration };
    case 'toggle-turn-groups':
      return { ...state, groupTurns: !state.groupTurns };
    case 'toggle-turn':
      return { ...state, collapsedTurns: toggled(state.collapsedTurns, action.turn) };
    case 'toggle-step':
      return {
        ...state,
        collapsedSteps: toggled(state.collapsedSteps, stepKey(action.turn, action.step)),
      };
    case 'toggle-calls': {
      const allCollapsed = [...action.steps].every((key) => state.collapsedSteps.has(key));
      return { ...state, collapsedSteps: allCollapsed ? new Set() : new Set(action.steps) };
    }
  }
}
