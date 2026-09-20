import { describe, expect, it } from 'vitest';
import type { Env } from '../src/worker/env';
import { handleRequest } from '../src/worker/index';

/** 开发旁路开启:聚焦 request_id 装配与转发 */
const devEnv = {
  GLM_API_KEY: 'test-key',
  NANO_API_BASE: 'http://127.0.0.1:8787',
  NANO_API_KEY: 'nano-key',
  CF_ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'test-aud',
  ACCESS_DEV_BYPASS: '1',
} as unknown as Env;

/** 生产语义:必须携带有效 Access JWT */
const prodEnv = {
  GLM_API_KEY: 'test-key',
  NANO_API_BASE: 'http://127.0.0.1:8787',
  NANO_API_KEY: 'nano-key',
  CF_ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
  CF_ACCESS_AUD: 'test-aud',
} as unknown as Env;

describe('request_id 装配(console 入口)', () => {
  it('代理响应携带 x-request-id,转发上游请求沿用同一 id(全链路共享)', async () => {
    const captured: Request[] = [];
    const upstreamOk = new Response(JSON.stringify({ data: [], next_page: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleRequest(
      new Request('http://localhost/nano/agent/managed/v1/agents'),
      devEnv,
      (input) => {
        captured.push(input as Request);
        return Promise.resolve(upstreamOk);
      },
    );
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(captured[0]?.headers.get('x-request-id')).toBe(id);
  });

  it('浏览器传入合法 id 时沿用:响应与上游请求保持同一 id', async () => {
    const captured: Request[] = [];
    const upstreamOk = new Response(JSON.stringify({ data: [], next_page: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const res = await handleRequest(
      new Request('http://localhost/glm/agent/managed/v1/agents', {
        headers: { 'x-request-id': 'req_chain12345a' },
      }),
      devEnv,
      (input) => {
        captured.push(input as Request);
        return Promise.resolve(upstreamOk);
      },
    );
    expect(res.headers.get('x-request-id')).toBe('req_chain12345a');
    expect(captured[0]?.headers.get('x-request-id')).toBe('req_chain12345a');
  });

  it('Access 拒绝(401)的响应同样携带 x-request-id', async () => {
    const res = await handleRequest(
      new Request('http://localhost/glm/agent/managed/v1/agents'),
      prodEnv,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toMatch(/^req_[0-9a-f-]{36}$/);
  });
});
