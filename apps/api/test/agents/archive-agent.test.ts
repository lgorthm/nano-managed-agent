import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentJson,
  applyMigrations,
  archiveAgentViaApi,
  createDefaultAgent,
  type ErrorEnvelope,
  getAgent,
  jsonBody,
  listAgents,
  listAgentVersions,
  type PageJson,
  updateAgent,
} from './helpers';

beforeAll(applyMigrations);

describe('POST /v1/agents/{agentId}/archive', () => {
  it('归档后 archived_at 填充,重复归档返回完全相同的响应', async () => {
    const created = await createDefaultAgent({
      name: 'to-archive',
      model: 'glm-5.3',
    });
    const first = await archiveAgentViaApi(created.id);
    expect(first.status).toBe(200);
    const archived = await jsonBody<AgentJson>(first);
    expect(archived.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(archived.version).toBe(1);
    // 除 archived_at 外,其余与创建响应一致
    expect({ ...archived, archived_at: null }).toEqual({
      ...created,
      archived_at: null,
    });

    const second = await archiveAgentViaApi(created.id);
    expect(second.status).toBe(200);
    expect(await jsonBody<AgentJson>(second)).toEqual(archived);
  });

  it('归档后再次 GET,archived_at 与归档响应一致且不再变化', async () => {
    const created = await createDefaultAgent({
      name: 'stable-ts',
      model: 'glm-5.3',
    });
    const archived = await jsonBody<AgentJson>(await archiveAgentViaApi(created.id));
    const got = await jsonBody<AgentJson>(await getAgent(created.id));
    expect(got.archived_at).toBe(archived.archived_at);
  });

  it('归档后 GET 与 GET /versions 仍可读', async () => {
    const created = await createDefaultAgent({
      name: 'readable',
      model: 'glm-5.3',
    });
    await archiveAgentViaApi(created.id);

    const got = await getAgent(created.id);
    expect(got.status).toBe(200);

    const versions = await jsonBody<PageJson<AgentJson>>(await listAgentVersions(created.id));
    expect(versions.data).toHaveLength(1);
    expect(versions.data[0]?.archived_at).not.toBeNull();
  });

  it('归档后 Agent 仍出现在列表中', async () => {
    const created = await createDefaultAgent({
      name: 'still-listed',
      model: 'glm-5.3',
    });
    await archiveAgentViaApi(created.id);
    const page = await jsonBody<PageJson<AgentJson>>(await listAgents('?limit=100'));
    const found = page.data.find((item) => item.id === created.id);
    expect(found).toBeDefined();
    expect(found?.archived_at).not.toBeNull();
  });

  it('端到端回归:归档后更新返回 400(M4 用直改库造状态,这里补真实路径)', async () => {
    const created = await createDefaultAgent({
      name: 'locked',
      model: 'glm-5.3',
    });
    await archiveAgentViaApi(created.id);
    const res = await updateAgent(created.id, { version: 1, system: 'nope' });
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.message).toContain('archived');

    // 数据未被改动
    const got = await jsonBody<AgentJson>(await getAgent(created.id));
    expect(got.system).toBeNull();
    expect(got.version).toBe(1);
  });

  it('不存在的 id 返回 404', async () => {
    const res = await archiveAgentViaApi('agent_01911111-1111-7111-8111-111111111111');
    expect(res.status).toBe(404);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe('not_found_error');
  });

  it('不带凭证返回 401', async () => {
    const created = await createDefaultAgent({
      name: 'authz',
      model: 'glm-5.3',
    });
    const res = await exports.default.fetch(`http://example.com/v1/agents/${created.id}/archive`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe('authentication_error');
  });
});
