import { collapseRecords, type LedgerRecord, type LedgerRow } from '../../../lib/session-ledger';

export const TRACE_ROW_HEIGHT = 27;
export const TRACE_COMPOSER_CLEARANCE = 140;
const EMPTY_TURNS: ReadonlySet<number> = new Set();

/** Folding is a pure projection. Requests remain ordinary, selectable records. */
export function buildTraceRows(
  records: LedgerRecord[],
  groupTurns: boolean,
  collapsedTurns: ReadonlySet<number>,
  collapsedSteps: ReadonlySet<string>,
): LedgerRow[] {
  const systemPrompt = records.filter((record) => record.raw.source === 'agent.system');
  const conversation = records.filter((record) => record.raw.source !== 'agent.system');
  const promptRows = systemPrompt.map((record) => ({
    key: record.key,
    record,
    height: TRACE_ROW_HEIGHT,
    turnStart: false,
    turnEnd: false,
  }));
  const conversationRows = collapseRecords(
    conversation,
    groupTurns ? collapsedTurns : EMPTY_TURNS,
    collapsedSteps,
  ).map((row) => ({ ...row, key: row.key.replace('\0', ':'), height: TRACE_ROW_HEIGHT }));
  return [...promptRows, ...conversationRows];
}
