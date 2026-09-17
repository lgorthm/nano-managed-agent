import { exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { authed } from './helpers';

/** 断言 401 响应是完整的错误信封,且 request_id 与响应头一致 */
async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  const body = (await res.json()) as {
    type: string;
    error: { type: string; message: string };
    request_id: string;
  };
  expect(body.type).toBe('error');
  expect(body.error.type).toBe('authentication_error');
  expect(typeof body.error.message).toBe('string');
  expect(body.request_id).toMatch(/^req_/);
  expect(res.headers.get('x-request-id')).toBe(body.request_id);
}

it('GET /v1 without credentials returns 401 error envelope', async () => {
  const res = await exports.default.fetch('http://example.com/v1');
  await expectUnauthorized(res);
});

it('GET /v1 with malformed Authorization header returns 401', async () => {
  const res = await exports.default.fetch('http://example.com/v1', {
    headers: { Authorization: 'dev-key-change-me' },
  });
  await expectUnauthorized(res);
});

it('GET /v1 with wrong key returns 401', async () => {
  const res = await exports.default.fetch('http://example.com/v1', {
    headers: { Authorization: 'Bearer wrong-key' },
  });
  await expectUnauthorized(res);
});

it('GET /v1 with correct key returns 200 and x-request-id header', async () => {
  const res = await exports.default.fetch('http://example.com/v1', {
    headers: authed(),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    service: 'nano-managed-agent',
    version: 'v1',
  });
  expect(res.headers.get('x-request-id')).toMatch(/^req_/);
});
