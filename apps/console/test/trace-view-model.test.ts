import type { PersistedEvent } from '@nano/shared/glm';
import { describe, expect, it } from 'vitest';
import {
  buildTraceRecords,
  findTraceMatches,
  getTraceDurationLabel,
  getTraceRecordStatus,
  getTraceRequestOptions,
} from '../src/web/features/session-trace/data/trace-view-model';

const FIRST_TIME = '2026-10-08T01:00:00.000Z';
const SECOND_TIME = '2026-10-08T01:00:01.000Z';
const SYSTEM_PROMPT = '请检查项目。\n确保修改正确。';

function systemMessage(fields: Record<string, unknown>): PersistedEvent {
  return { id: 'system-notice', type: 'system.message', processed_at: FIRST_TIME, ...fields };
}

describe('buildTraceRecords', () => {
  it('沙箱恢复通知不屏蔽 Agent 的真实系统配置', () => {
    const recoveryNotice = systemMessage({ content: '沙箱已经恢复。' });
    const records = buildTraceRecords([recoveryNotice], SYSTEM_PROMPT);
    expect(records.map((record) => record.raw.content)).toEqual([
      SYSTEM_PROMPT,
      recoveryNotice.content,
    ]);
    expect(records[0]).toMatchObject({
      key: 'session-system-prompt',
      startedAt: null,
      durationMs: null,
      raw: { source: 'agent.system' },
    });
    expect(getTraceRecordStatus(records[0]!)).toBe('配置');
    expect(getTraceDurationLabel(records[0]!)).toBe('不适用');
    expect(getTraceRecordStatus(records[1]!)).toBe('已完成');
  });

  it.each([
    { source: 'agent.system', content: '来自 Agent 配置。' },
    { content: `  ${SYSTEM_PROMPT}\n` },
    {
      content: [
        { type: 'text', text: '请检查项目。' },
        { type: 'text', text: '确保修改正确。' },
      ],
    },
    { message: SYSTEM_PROMPT },
  ])('已有配置来源或内容匹配的系统消息时，不重复补充系统配置：%j', (fields) => {
    const records = buildTraceRecords([systemMessage(fields)], SYSTEM_PROMPT);
    expect(records).toHaveLength(1);
    expect(records[0]?.key).toBe('system-notice');
  });

  it('普通未处理消息仍然显示排队状态与未知耗时', () => {
    const records = buildTraceRecords(
      [{ id: 'queued', type: 'user.message', processed_at: null, content: '继续' }],
      null,
    );
    expect(getTraceRecordStatus(records[0]!)).toBe('排队中');
    expect(getTraceDurationLabel(records[0]!)).toBe('未提供');
  });
});

describe('span 请求详情', () => {
  function requestRecord(startFields: Record<string, unknown>, endFields: Record<string, unknown>) {
    return buildTraceRecords(
      [
        {
          id: 'request-start',
          type: 'span.model_request_start',
          processed_at: FIRST_TIME,
          ...startFields,
        },
        {
          id: 'request-end',
          type: 'span.model_request_end',
          processed_at: SECOND_TIME,
          ...endFields,
        },
      ],
      null,
    )[0]!;
  }

  it('结束载荷保留 usage，同时请求选项可从开始载荷读取', () => {
    const options = { temperature: 0.4, instruction: 'needle in request options' };
    const usage = { input_tokens: 10, output_tokens: 20 };
    const record = requestRecord({ options }, { usage });
    expect(record.raw.usage).toEqual(usage);
    expect(record.startRaw?.options).toEqual(options);
    expect(getTraceRequestOptions(record)).toEqual(options);
    expect(record.durationMs).toBe(1000);
    expect(findTraceMatches([record], [], 'needle in request options')).toEqual(
      new Set(['request-start']),
    );
  });

  it('结束事件 options 优先于开始事件 options', () => {
    const record = requestRecord(
      { options: { temperature: 0.4 } },
      { options: { temperature: 0.2 } },
    );
    expect(getTraceRequestOptions(record)).toEqual({ temperature: 0.2 });
  });

  it('开始事件 options 优先于兼容字段，缺少 options 时回退到 request_options', () => {
    expect(
      getTraceRequestOptions(
        requestRecord({ options: { temperature: 0.4 } }, { request_options: { temperature: 0.2 } }),
      ),
    ).toEqual({ temperature: 0.4 });
    expect(
      getTraceRequestOptions(requestRecord({ request_options: { temperature: 0.4 } }, {})),
    ).toEqual({ temperature: 0.4 });
  });
});
