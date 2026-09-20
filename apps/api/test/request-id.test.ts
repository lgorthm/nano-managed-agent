import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** 捕获结构化日志行(console 方法收到的是 JSON 字符串) */
function captureLog(method: 'log' | 'warn' | 'error') {
  const spy = vi.spyOn(console, method).mockImplementation(() => {});
  return {
    spy,
    lines: () =>
      spy.mock.calls
        .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
        .filter((line) => typeof line.msg === 'string'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('request_id 装配', () => {
  it('成功响应带 x-request-id,完成行日志携带同一 id', async () => {
    const { lines } = captureLog('log');
    const res = await exports.default.fetch('http://example.com/');
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(lines().find((line) => line.msg === 'request completed')).toMatchObject({
      requestId: id,
      method: 'GET',
      path: '/',
      status: 200,
    });
  });

  it('合法传入 id 被沿用(网关/console 转发链路共享同一 id)', async () => {
    captureLog('log');
    const res = await exports.default.fetch('http://example.com/', {
      headers: { 'x-request-id': 'req_chain12345a' },
    });
    expect(res.headers.get('x-request-id')).toBe('req_chain12345a');
  });

  it('非法传入 id 被替换(白名单校验,防伪造与日志注入)', async () => {
    captureLog('log');
    const res = await exports.default.fetch('http://example.com/', {
      headers: { 'x-request-id': 'evil id with spaces' },
    });
    expect(res.headers.get('x-request-id')).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it('错误响应:401 带 x-request-id,错误完成行 warn 携带同一 id,信封同 id', async () => {
    const { lines } = captureLog('warn');
    const res = await exports.default.fetch('http://example.com/v1');
    const id = res.headers.get('x-request-id');
    expect(res.status).toBe(401);
    expect(id).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(lines().find((line) => line.msg === 'request failed')).toMatchObject({
      requestId: id,
      status: 401,
      errorType: 'authentication_error',
    });
    const body = (await res.json()) as { request_id: string };
    expect(body.request_id).toBe(id);
  });
});
