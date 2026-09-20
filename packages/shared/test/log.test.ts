import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentRequestId, type LogLevel, log, resolveRequestId, withRequestId } from '../src/log';

type ConsoleSpy = ReturnType<typeof vi.spyOn>;

/** 捕获 console 输出并解析为结构化行(首次访问时收集一次) */
function captureConsole(): { lines: Array<Record<string, unknown>>; spies: ConsoleSpy[] } {
  const calls: unknown[][] = [];
  const push = (spy: ConsoleSpy) => calls.push(...spy.mock.calls);
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  let collected: Array<Record<string, unknown>> | null = null;
  return {
    get lines() {
      if (collected === null) {
        [consoleLog, consoleWarn, consoleError].forEach(push);
        collected = calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
      }
      return collected;
    },
    spies: [consoleLog, consoleWarn, consoleError],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withRequestId / currentRequestId', () => {
  it('作用域内可读取,作用域外为 null', () => {
    expect(currentRequestId()).toBeNull();
    withRequestId('req_test', () => {
      expect(currentRequestId()).toBe('req_test');
    });
    expect(currentRequestId()).toBeNull();
  });

  it('跨 await 点保持上下文', async () => {
    await withRequestId('req_async', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(currentRequestId()).toBe('req_async');
    });
  });
});

describe('resolveRequestId', () => {
  it('合法传入值原样沿用', () => {
    expect(resolveRequestId('req_12345678')).toBe('req_12345678');
  });

  it('缺失 / 非法前缀 / 非法字符 / 超长时生成新 id', () => {
    const generated = [undefined, null, 'abc_12345678', 'req_!!', `req_${'a'.repeat(65)}`].map(
      (value) => resolveRequestId(value),
    );
    for (const id of generated) expect(id).toMatch(/^req_[0-9a-f-]{36}$/);
  });
});

describe('log 结构化输出', () => {
  it('各级别路由到对应 console 方法并输出 JSON 行', () => {
    const cap = captureConsole();
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(cap.lines.map((line) => line.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(cap.lines.map((line) => line.msg)).toEqual(['d', 'i', 'w', 'e']);
    const channels: Record<LogLevel, ConsoleSpy> = {
      debug: cap.spies[0],
      info: cap.spies[0],
      warn: cap.spies[1],
      error: cap.spies[2],
    };
    // debug 与 info 同走 console.log 通道
    expect(channels.debug).toHaveBeenCalledTimes(2);
    expect(channels.warn).toHaveBeenCalledTimes(1);
    expect(channels.error).toHaveBeenCalledTimes(1);
  });

  it('请求作用域内自动携带 requestId 字段,作用域外缺席', () => {
    const cap = captureConsole();
    log.info('outside');
    withRequestId('req_in', () => {
      log.info('inside');
    });
    expect(cap.lines[0]).not.toHaveProperty('requestId');
    expect(cap.lines[1]).toMatchObject({ requestId: 'req_in' });
  });

  it('附加字段展开;err 序列化为 name/message/stack', () => {
    const cap = captureConsole();
    const boom = new Error('kaboom');
    log.error('failed', { sessionId: 's_1', turnId: 42, err: boom });
    const line = cap.lines[0] as {
      sessionId: string;
      turnId: number;
      err: { name: string; message: string; stack?: string };
    };
    expect(line.sessionId).toBe('s_1');
    expect(line.turnId).toBe(42);
    expect(line.err.name).toBe('Error');
    expect(line.err.message).toBe('kaboom');
    expect(typeof line.err.stack).toBe('string');
  });

  it('非 Error 抛出物降级序列化', () => {
    const cap = captureConsole();
    log.error('failed', { err: 'plain string' });
    expect(cap.lines[0]).toMatchObject({ err: { name: 'NonError', message: 'plain string' } });
  });

  it('显式传入的 requestId 字段优先生效(onError 重进入场景)', () => {
    const cap = captureConsole();
    log.error('failed', { requestId: 'req_explicit' });
    expect(cap.lines[0]).toMatchObject({ requestId: 'req_explicit' });
  });
});
