import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentJson,
  applyMigrations,
  createDefaultAgent,
  type ErrorEnvelope,
  getAgent,
  jsonBody,
} from './helpers';

beforeAll(applyMigrations);

describe('GET /v1/agents/{agentId}', () => {
  it('创建后按 id 获取,响应与创建响应逐字段一致', async () => {
    const created = await createDefaultAgent({
      name: 'Coding Assistant',
      model: 'glm-5.3',
      system: 'You are a helpful coding agent.',
      tools: [{ type: 'agent_toolset_20260601' }],
    });
    const res = await getAgent(created.id);
    expect(res.status).toBe(200);
    const body = await jsonBody<AgentJson>(res);
    expect(body).toEqual(created);
  });

  it('不存在的 id 返回 404 完整错误信封', async () => {
    const res = await getAgent('agent_01911111-1111-7111-8111-111111111111');
    expect(res.status).toBe(404);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.type).toBe('error');
    expect(envelope.error.type).toBe('not_found_error');
    expect(typeof envelope.error.message).toBe('string');
    expect(envelope.request_id).toMatch(/^req_/);
    expect(res.headers.get('x-request-id')).toBe(envelope.request_id);
  });

  it('格式任意的不存在标识同样返回 404 而不是 500', async () => {
    for (const id of ['definitely-not-here', 'agent_', '%20%2Fslash']) {
      const res = await getAgent(id);
      expect(res.status).toBe(404);
      const envelope = await jsonBody<ErrorEnvelope>(res);
      expect(envelope.error.type).toBe('not_found_error');
    }
  });

  it('不带凭证返回 401', async () => {
    const created = await createDefaultAgent();
    const res = await exports.default.fetch(`http://example.com/v1/agents/${created.id}`);
    expect(res.status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe('authentication_error');
  });
});
