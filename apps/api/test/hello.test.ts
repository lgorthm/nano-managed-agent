import { exports } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { authed } from './helpers';

it('GET / returns hello', async () => {
  const res = await exports.default.fetch('http://example.com/');
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('Hello from nano-managed-agent');
});

it('GET /v1 returns service info', async () => {
  const res = await exports.default.fetch('http://example.com/v1', {
    headers: authed(),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    service: 'nano-managed-agent',
    version: 'v1',
  });
});
