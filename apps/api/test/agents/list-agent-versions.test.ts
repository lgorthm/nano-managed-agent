import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentJson,
  applyMigrations,
  archiveAgentInDb,
  createDefaultAgent,
  type ErrorEnvelope,
  jsonBody,
  listAgents,
  listAgentVersions,
  type PageJson,
  updateAgent,
} from './helpers';

beforeAll(applyMigrations);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 创建一个更新过两次的 Agent(3 个版本),版本间留 5ms 保证时间戳可分辨 */
async function createThreeVersionAgent(): Promise<AgentJson> {
  const created = await createDefaultAgent({
    name: 'history',
    model: 'glm-5.3',
    system: 'v1',
  });
  await sleep(5);
  await updateAgent(created.id, { version: 1, system: 'v2' });
  await sleep(5);
  const third = await updateAgent(created.id, { version: 2, system: 'v3' });
  if (third.status !== 200) throw new Error(`fixture update failed: ${await third.text()}`);
  return { ...created, version: 3 };
}

describe('GET /v1/agents/{agentId}/versions', () => {
  it('更新过两次的 Agent 有 3 个版本,按 version 倒序,每条是当时的完整快照', async () => {
    const agent = await createThreeVersionAgent();
    const res = await listAgentVersions(agent.id);
    expect(res.status).toBe(200);
    const page = await jsonBody<PageJson<AgentJson>>(res);
    expect(page.data).toHaveLength(3);
    expect(page.next_page).toBeNull();

    const [v3, v2, v1] = page.data as [AgentJson, AgentJson, AgentJson];
    expect([v3.version, v2.version, v1.version]).toEqual([3, 2, 1]);
    // 每个条目回显当时的 system,而不是当前值
    expect(v1.system).toBe('v1');
    expect(v2.system).toBe('v2');
    expect(v3.system).toBe('v3');
    // 快照的公共字段一致
    for (const entry of page.data) {
      expect(entry.id).toBe(agent.id);
      expect(entry.type).toBe('agent');
      expect(entry.name).toBe('history');
      expect(entry.multiagent).toBeNull();
      expect(entry.archived_at).toBeNull();
    }
  });

  it('各版本有版本级时间戳:递增且 created_at === updated_at(不可变快照)', async () => {
    const agent = await createThreeVersionAgent();
    const page = await jsonBody<PageJson<AgentJson>>(
      await listAgentVersions(agent.id, '?order=asc'),
    );
    const [v1, v2, v3] = page.data as [AgentJson, AgentJson, AgentJson];
    expect(v1.created_at).toBe(v1.updated_at);
    expect(v2.created_at).toBe(v2.updated_at);
    expect(v3.created_at).toBe(v3.updated_at);
    expect(new Date(v2.created_at).getTime()).toBeGreaterThan(new Date(v1.created_at).getTime());
    expect(new Date(v3.created_at).getTime()).toBeGreaterThan(new Date(v2.created_at).getTime());
  });

  it('游标翻页:limit=2 取前两页,不重不漏', async () => {
    const agent = await createThreeVersionAgent();
    const page1 = await jsonBody<PageJson<AgentJson>>(
      await listAgentVersions(agent.id, '?limit=2'),
    );
    expect(page1.data.map((v) => v.version)).toEqual([3, 2]);
    expect(page1.next_page).toBeTruthy();

    const page2 = await jsonBody<PageJson<AgentJson>>(
      await listAgentVersions(agent.id, `?limit=2&page=${page1.next_page}`),
    );
    expect(page2.data.map((v) => v.version)).toEqual([1]);
    expect(page2.next_page).toBeNull();
  });

  it('归档后所有条目的 archived_at 回显同一个 Agent 级值', async () => {
    const agent = await createThreeVersionAgent();
    await archiveAgentInDb(agent.id);
    const page = await jsonBody<PageJson<AgentJson>>(await listAgentVersions(agent.id));
    expect(page.data).toHaveLength(3);
    for (const entry of page.data) {
      expect(entry.archived_at).toBeTruthy();
      expect(entry.archived_at).toBe(page.data[0]!.archived_at);
    }
  });

  it('不存在的 Agent 返回 404', async () => {
    const res = await listAgentVersions('agent_01911111-1111-7111-8111-111111111111');
    expect(res.status).toBe(404);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe('not_found_error');
  });

  it('agents 列表的游标不能用于本端点(kind 不匹配返回 400)', async () => {
    const agent = await createThreeVersionAgent();
    const agentsPage = await jsonBody<PageJson<AgentJson>>(await listAgents('?limit=1'));
    const foreignCursor = agentsPage.next_page;
    if (!foreignCursor) throw new Error('expected agents cursor');
    const res = await listAgentVersions(agent.id, `?page=${foreignCursor}`);
    expect(res.status).toBe(400);
  });
});
