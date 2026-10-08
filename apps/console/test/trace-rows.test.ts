import { describe, expect, it } from 'vitest';
import {
  buildTraceRows,
  TRACE_ROW_HEIGHT,
} from '../src/web/features/session-trace/data/trace-rows';
import { buildLedger, stepKey } from '../src/web/lib/session-ledger';

function conversationRecords() {
  return buildLedger([
    {
      id: 'system-prompt',
      type: 'system.message',
      source: 'agent.system',
      content: 'Follow the project instructions.',
    },
    { id: 'user', type: 'user.message', content: 'Inspect this project.' },
    { id: 'request', type: 'span.model_request_start' },
    { id: 'assistant', type: 'agent.message', content: 'I will inspect the files.' },
    { id: 'list-files', type: 'agent.tool_use', name: 'bash', input: { command: 'ls' } },
    { id: 'read-file', type: 'agent.tool_use', name: 'read', input: { path: 'README.md' } },
  ]);
}

describe('buildTraceRows', () => {
  it('keeps the configured system prompt outside turn folding and marks the user as the turn start', () => {
    const records = conversationRecords();
    const rows = buildTraceRows(records, true, new Set([1]), new Set());

    expect(rows.map((row) => row.key)).toEqual(['system-prompt', 'user', 'turn:1:summary']);
    expect(rows[0]).toMatchObject({ record: records[0], turnStart: false, turnEnd: false });
    expect(rows[1]).toMatchObject({ record: records[1], turnStart: true });
    expect(rows[2]).toMatchObject({ record: null, collapsed: { kind: 'turn', turn: 1 } });
  });

  it('preserves a request record and its selection key in the visible projection', () => {
    const records = conversationRecords();
    const rows = buildTraceRows(records, true, new Set(), new Set());
    const requestRow = rows.find((row) => row.key === 'request');

    expect(rows.map((row) => row.key)).toEqual(records.map((record) => record.key));
    expect(requestRow?.record).toBe(records.find((record) => record.kind === 'span'));
    expect(requestRow?.collapsed).toBeUndefined();
    expect(rows.every((row) => row.height === TRACE_ROW_HEIGHT)).toBe(true);
  });

  it('folds turns and tool steps without changing the ledger or its record identities', () => {
    const records = conversationRecords();
    const original = structuredClone(records);
    records.forEach((record) => {
      Object.freeze(record.raw);
      Object.freeze(record);
    });
    Object.freeze(records);

    const turnRows = buildTraceRows(records, true, new Set([1]), new Set());
    const stepRows = buildTraceRows(records, true, new Set(), new Set([stepKey(1, 1)]));
    const ungroupedRows = buildTraceRows(records, false, new Set([1]), new Set());

    expect(turnRows).toHaveLength(3);
    expect(stepRows.map((row) => row.key)).toEqual([
      'system-prompt',
      'user',
      'request',
      'assistant',
      'step:1:1:summary',
    ]);
    expect(stepRows.at(-1)).toMatchObject({
      record: null,
      collapsed: { kind: 'step', turn: 1, step: 1 },
    });
    expect(ungroupedRows.map((row) => row.record)).toEqual(records);
    expect(stepRows[3]?.record).toBe(records[3]);
    expect(records).toEqual(original);
  });
});
