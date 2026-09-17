import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  archiveEnvironmentInDb,
  createDefaultEnvironment,
  type EnvironmentJson,
  type ErrorEnvelope,
  getEnvironment,
  jsonBody,
} from './helpers';

beforeAll(applyMigrations);

describe('GET /v1/environments/{environmentId}', () => {
  it('创建后获取,字段与创建响应完全一致', async () => {
    const created = await createDefaultEnvironment({
      name: 'fetch-me',
      description: 'd',
    });
    const res = await getEnvironment(created.id);
    expect(res.status).toBe(200);
    expect(await jsonBody<EnvironmentJson>(res)).toEqual(created);
  });

  it('不存在的 id 返回 404 完整错误信封', async () => {
    const res = await getEnvironment('env_01911111-0000-7000-8000-000000000000');
    expect(res.status).toBe(404);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.type).toBe('error');
    expect(envelope.error.type).toBe('not_found_error');
    expect(envelope.request_id).toMatch(/^req_/);
  });

  it('path 参数为任意合法字符串同样 404 而不是 500', async () => {
    const res = await getEnvironment('env_not-a-real-id');
    expect(res.status).toBe(404);
  });

  it('已归档的环境(直改库)同样可以读取', async () => {
    const created = await createDefaultEnvironment({ name: 'archived-read' });
    await archiveEnvironmentInDb(created.id);
    const res = await getEnvironment(created.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<EnvironmentJson>(res);
    expect(body.state).toBe('archived');
    expect(body.archived_at).not.toBeNull();
  });

  it('不带凭证返回 401', async () => {
    const created = await createDefaultEnvironment();
    const res = await exports.default.fetch(
      `http://example.com/v1/environments/${encodeURIComponent(created.id)}`,
    );
    expect(res.status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe('authentication_error');
  });
});
