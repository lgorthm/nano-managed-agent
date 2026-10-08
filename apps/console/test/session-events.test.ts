import type { Page, PersistedEvent, SessionEventListQuery } from '@nano/shared/glm';
import { describe, expect, it, vi } from 'vitest';
import {
  loadSessionEventHistory,
  mergeSessionEvents,
  retainUnpersistedEvents,
} from '../src/web/features/session-trace/data/session-events';

const FIRST_TIME = '2026-10-08T01:00:00.000Z';
const SECOND_TIME = '2026-10-08T01:00:01.000Z';

function event(id: string, processedAt: string | null = FIRST_TIME): PersistedEvent {
  return { id, type: 'agent.message', processed_at: processedAt };
}

describe('mergeSessionEvents', () => {
  it('保留历史顺序，在其后追加新的实时事件，不按照处理时间重新排序', () => {
    const history = [event('first', SECOND_TIME), event('second', FIRST_TIME)];
    const live = [event('third'), event('first')];
    expect(mergeSessionEvents(history, live).map((item) => item.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('历史与实时都已完成时使用历史版本，实时重复帧自身也只保留一个位置', () => {
    const historical = { ...event('known'), content: [{ type: 'text', text: '历史版本' }] };
    const finalLive = { ...event('new'), content: [{ type: 'text', text: '完整实时版本' }] };
    const result = mergeSessionEvents(
      [historical],
      [event('known', SECOND_TIME), event('new', null), finalLive],
    );
    expect(result).toEqual([historical, finalLive]);
  });

  it('历史仍然排队时保留实时已处理版本，历史回填后重新使用历史版本', () => {
    const queued = event('same', null);
    const processedLive = event('same', SECOND_TIME);
    expect(mergeSessionEvents([queued], [processedLive])).toEqual([processedLive]);

    const processedHistory = event('same', FIRST_TIME);
    expect(mergeSessionEvents([processedHistory], [processedLive])).toEqual([processedHistory]);
  });

  it('实时流中的较旧排队重复帧不会覆盖已处理版本，无 id 的帧不会互相覆盖', () => {
    const complete = event('same', SECOND_TIME);
    const unknownOne = { type: 'unknown', raw: 'one' };
    const unknownTwo = { type: 'unknown', raw: 'two' };
    expect(mergeSessionEvents([], [complete, event('same', null), unknownOne, unknownTwo])).toEqual(
      [complete, unknownOne, unknownTwo],
    );
  });

  it('不修改输入数组或原始事件对象', () => {
    const historical = Object.freeze(event('same', null));
    const live = Object.freeze(event('same', SECOND_TIME));
    const history = Object.freeze([historical]);
    const incoming = Object.freeze([live]);
    expect(mergeSessionEvents(history, incoming)).toEqual([live]);
    expect(historical.processed_at).toBeNull();
  });
});

describe('retainUnpersistedEvents', () => {
  it('释放已进入完整历史的实时记录，保留历史中缺失的事件和待回填的完整版本', () => {
    const history = [event('complete'), event('queued', null), event('still-queued', null)];
    const betterLive = event('queued', SECOND_TIME);
    const freshLive = event('new');
    const unknown = { type: 'unknown', raw: 'unidentified' };
    const live = [event('complete'), betterLive, event('still-queued', null), freshLive, unknown];
    expect(retainUnpersistedEvents(history, live)).toEqual([betterLive, freshLive, unknown]);
    expect(retainUnpersistedEvents([event('queued')], [betterLive])).toEqual([]);
  });
});

describe('loadSessionEventHistory', () => {
  it('读取超过 100 条的完整历史，传递游标与取消信号并保持服务器顺序', async () => {
    const events = Array.from({ length: 205 }, (_, index) => event(`event-${index}`));
    const pages: Page<PersistedEvent>[] = [
      { data: events.slice(0, 100), next_page: 'page-two' },
      { data: events.slice(100, 200), next_page: 'page-three' },
      { data: events.slice(200), next_page: null },
    ];
    const requestPage = vi.fn(async (_query: SessionEventListQuery, _signal?: AbortSignal) => {
      return pages.shift()!;
    });
    const controller = new AbortController();
    const history = await loadSessionEventHistory(requestPage, controller.signal);

    expect(history).toEqual({ data: events, next_page: null });
    expect(requestPage.mock.calls).toEqual([
      [{ order: 'asc', limit: 100 }, controller.signal],
      [{ order: 'asc', limit: 100, page: 'page-two' }, controller.signal],
      [{ order: 'asc', limit: 100, page: 'page-three' }, controller.signal],
    ]);
  });

  it('相邻分页重叠时保持第一次出现的位置，并保留回填后的版本', async () => {
    const completed = event('overlap', SECOND_TIME);
    const pages: Page<PersistedEvent>[] = [
      { data: [event('first'), event('overlap', null)], next_page: 'next' },
      { data: [completed, event('last')], next_page: null },
    ];
    const history = await loadSessionEventHistory(async () => pages.shift()!);
    expect(history.data).toEqual([event('first'), completed, event('last')]);
  });

  it('重复游标会报错，避免无限请求', async () => {
    const requestPage = vi.fn(async () => ({ data: [], next_page: 'repeated' }));
    await expect(loadSessionEventHistory(requestPage)).rejects.toThrow('repeated cursor');
    expect(requestPage).toHaveBeenCalledTimes(2);
  });

  it('请求开始前取消时不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const requestPage = vi.fn(async () => ({ data: [], next_page: null }));
    await expect(loadSessionEventHistory(requestPage, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(requestPage).not.toHaveBeenCalled();
  });

  it('分页过程中取消时停止读取后续页', async () => {
    const controller = new AbortController();
    const requestPage = vi.fn(async () => {
      controller.abort();
      return { data: [event('first')], next_page: 'next' };
    });
    await expect(loadSessionEventHistory(requestPage, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(requestPage).toHaveBeenCalledTimes(1);
  });

  it('后续分页失败时向上传递错误，不提交缺少后半段的历史快照', async () => {
    const error = new Error('network unavailable');
    const requestPage = vi
      .fn<() => Promise<Page<PersistedEvent>>>()
      .mockResolvedValueOnce({ data: [event('first')], next_page: 'next' })
      .mockRejectedValueOnce(error);
    await expect(loadSessionEventHistory(requestPage)).rejects.toBe(error);
  });
});
