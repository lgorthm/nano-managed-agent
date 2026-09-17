import { beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  archiveSessionInDb,
  createDefaultAgent,
  createDefaultSession,
  type ErrorEnvelope,
  jsonBody,
  listSessions,
  type PageJson,
  type SessionJson,
} from './helpers';

beforeAll(applyMigrations);

describe('GET /v1/sessions 列表与分页', () => {
  it('按 agent_id 过滤,默认按创建时间倒序,游标翻页', async () => {
    const agent = await createDefaultAgent();
    const created: SessionJson[] = [];
    for (let i = 0; i < 3; i++) {
      created.push(await createDefaultSession({ agent: agent.id, title: `s-${i}` }));
    }

    const first = await listSessions(`?agent_id=${agent.id}&limit=2`);
    expect(first.status).toBe(200);
    const page1 = await jsonBody<PageJson<SessionJson>>(first);
    expect(page1.data).toHaveLength(2);
    expect(page1.next_page).not.toBeNull();
    // 倒序:最新创建的在前
    expect(page1.data[0]?.id).toBe(created[2]?.id);
    expect(page1.data[1]?.id).toBe(created[1]?.id);

    const second = await listSessions(
      `?agent_id=${agent.id}&limit=2&page=${encodeURIComponent(page1.next_page!)}`,
    );
    const page2 = await jsonBody<PageJson<SessionJson>>(second);
    expect(page2.data.map((row) => row.id)).toContain(created[0]?.id);
    expect(page2.next_page).toBeNull();
  });

  it('order=asc 正序;limit 截断与非法值', async () => {
    const agent = await createDefaultAgent();
    await createDefaultSession({ agent: agent.id });
    await createDefaultSession({ agent: agent.id });
    const res = await listSessions(`?agent_id=${agent.id}&order=asc&limit=10`);
    const page = await jsonBody<PageJson<SessionJson>>(res);
    // 断言"列表本身按 (created_at, id) 升序",不断言两个夹具的创建先后——
    // 同毫秒创建时 keyset 回退到 id 比较(随机序),按创建顺序断言会抖动
    const sorted = [...page.data].sort(
      (x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id),
    );
    expect(page.data).toEqual(sorted);

    expect((await listSessions('?limit=0')).status).toBe(400);
    expect((await listSessions('?order=sideways')).status).toBe(400);
    expect((await listSessions('?page=not-a-cursor')).status).toBe(400);
  });
});

describe('GET /v1/sessions 已归档可见性(与 agents/environments 列表相反)', () => {
  it('默认排除已归档,include_archived=true 包含', async () => {
    const agent = await createDefaultAgent();
    const active = await createDefaultSession({ agent: agent.id });
    const archived = await createDefaultSession({ agent: agent.id });
    await archiveSessionInDb(archived.id);

    const excluded = await jsonBody<PageJson<SessionJson>>(
      await listSessions(`?agent_id=${agent.id}&limit=100`),
    );
    const excludedIds = excluded.data.map((row) => row.id);
    expect(excludedIds).toContain(active.id);
    expect(excludedIds).not.toContain(archived.id);

    const included = await jsonBody<PageJson<SessionJson>>(
      await listSessions(`?agent_id=${agent.id}&limit=100&include_archived=true`),
    );
    expect(included.data.map((row) => row.id)).toContain(archived.id);
    expect(included.data.find((row) => row.id === archived.id)?.archived_at).not.toBeNull();
  });
});

describe('GET /v1/sessions 过滤参数', () => {
  it('agent_id + agent_version 过滤匹配钉住的版本;version 单独出现 400', async () => {
    const agent = await createDefaultAgent();
    const { updateAgent } = await import('../agents/helpers');
    await updateAgent(agent.id, { system: 'v2' });
    // 钉 v1 与钉 v2 各一个会话
    const pinnedV1 = await createDefaultSession({
      agent: { type: 'agent', id: agent.id, version: 1 },
    });
    await createDefaultSession({ agent: agent.id });

    const onlyV1 = await jsonBody<PageJson<SessionJson>>(
      await listSessions(`?agent_id=${agent.id}&agent_version=1`),
    );
    const onlyV1Ids = onlyV1.data.map((row) => row.id);
    expect(onlyV1Ids).toContain(pinnedV1.id);
    expect(onlyV1.data.every((row) => row.agent.version === 1)).toBe(true);

    expect((await listSessions('?agent_version=1')).status).toBe(400);
    expect((await listSessions('?agent_version=abc')).status).toBe(400);
  });

  it('statuses[] 重复参数过滤', async () => {
    const agent = await createDefaultAgent();
    const session = await createDefaultSession({ agent: agent.id });
    const res = await listSessions(`?agent_id=${agent.id}&statuses[]=idle&statuses[]=running`);
    expect(res.status).toBe(200);
    const page = await jsonBody<PageJson<SessionJson>>(res);
    expect(page.data.map((row) => row.id)).toContain(session.id);

    expect((await listSessions('?statuses[]=unknown')).status).toBe(400);
  });

  it('created_at 区间过滤,非法时间 400', async () => {
    const agent = await createDefaultAgent();
    const session = await createDefaultSession({ agent: agent.id });
    const before = new Date(Date.parse(session.created_at) - 60_000).toISOString();
    const after = new Date(Date.parse(session.created_at) + 60_000).toISOString();

    const hit = await jsonBody<PageJson<SessionJson>>(
      await listSessions(
        `?agent_id=${agent.id}&created_at[gte]=${encodeURIComponent(before)}&created_at[lt]=${encodeURIComponent(after)}`,
      ),
    );
    expect(hit.data.map((row) => row.id)).toContain(session.id);

    const miss = await jsonBody<PageJson<SessionJson>>(
      await listSessions(`?agent_id=${agent.id}&created_at[gte]=${encodeURIComponent(after)}`),
    );
    expect(miss.data.map((row) => row.id)).not.toContain(session.id);

    expect((await listSessions(`?created_at[gte]=yesterday`)).status).toBe(400);
  });

  it('memory_store_id 一期提供即 400;include_archived 非法值 400', async () => {
    const memory = await listSessions('?memory_store_id=ms_1');
    expect(memory.status).toBe(400);
    expect((await jsonBody<ErrorEnvelope>(memory)).error.type).toBe('invalid_request_error');
    expect((await listSessions('?include_archived=yes')).status).toBe(400);
  });
});
