import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AgentJson,
  applyMigrations,
  archiveSessionInDb,
  createDefaultSession,
  type ErrorEnvelope,
  jsonBody,
  type SessionJson,
  setSessionStatusInDb,
  updateSession,
} from './helpers';

beforeAll(applyMigrations);

describe('POST /v1/sessions/{sessionId} 更新规则', () => {
  it('title 替换与 null 清空', async () => {
    const created = await createDefaultSession({
      title: 'old title',
      metadata: { keep: 'me' },
    });

    const renamed = await jsonBody<SessionJson>(
      await updateSession(created.id, { title: 'new title' }),
    );
    expect(renamed.title).toBe('new title');
    expect(renamed.metadata).toEqual({ keep: 'me' });
    expect(renamed.updated_at >= created.updated_at).toBe(true);

    const cleared = await jsonBody<SessionJson>(await updateSession(created.id, { title: null }));
    expect(cleared.title).toBeNull();
  });

  it('metadata 按键合并:覆盖、删键、保留未提及键', async () => {
    const created = await createDefaultSession({
      metadata: { a: '1', b: '2' },
    });
    const body = await jsonBody<SessionJson>(
      await updateSession(created.id, {
        metadata: { b: 'two', c: '3', a: null },
      }),
    );
    expect(body.metadata).toEqual({ b: 'two', c: '3' });
  });

  it('agent.tools 整体替换进固化快照,Agent 本体不变', async () => {
    const created = await createDefaultSession();
    const body = await jsonBody<SessionJson>(
      await updateSession(created.id, {
        agent: {
          tools: [
            {
              type: 'agent_toolset_20260601',
              configs: [{ name: 'bash', permission_policy: { type: 'always_ask' } }],
            },
          ],
        },
      }),
    );
    expect(body.agent.tools).toEqual([
      {
        type: 'agent_toolset_20260601',
        default_config: {
          enabled: true,
          permission_policy: { type: 'always_allow' },
        },
        configs: [
          {
            name: 'bash',
            enabled: true,
            permission_policy: { type: 'always_ask' },
          },
        ],
      },
    ]);
    expect(body.agent.system).toBe(created.agent.system);

    // Agent 本体不变
    const { getAgent } = await import('../agents/helpers');
    const agent = await jsonBody<AgentJson>(await getAgent(created.agent.id));
    expect(agent.tools).toEqual([]);
  });

  it('替换后 mcp 映射不一致返回 400', async () => {
    const created = await createDefaultSession();
    const res = await updateSession(created.id, {
      agent: { tools: [{ type: 'mcp_toolset', mcp_server_name: 'kb' }] },
    });
    expect(res.status).toBe(400);
  });

  it('冻结字段与空对象拒绝', async () => {
    const created = await createDefaultSession();
    for (const body of [
      {},
      { agent: {} },
      { model: 'glm-5.3' },
      { system: 'x' },
      { skills: [] },
      { vault_ids: [] },
      { environment_id: created.environment_id },
      { resources: [] },
    ]) {
      const res = await updateSession(created.id, body);
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('无变化更新不写库,updated_at 不变', async () => {
    const created = await createDefaultSession({
      title: 'same',
      metadata: { k: 'v' },
    });
    const body = await jsonBody<SessionJson>(
      await updateSession(created.id, { title: 'same', metadata: { k: 'v' } }),
    );
    expect(body.updated_at).toBe(created.updated_at);
  });
});

describe('POST /v1/sessions/{sessionId} 409 与 404', () => {
  it('已归档会话更新返回 409(session_archived)', async () => {
    const created = await createDefaultSession();
    await archiveSessionInDb(created.id);
    const res = await updateSession(created.id, { title: 'nope' });
    expect(res.status).toBe(409);
    const error = await jsonBody<ErrorEnvelope>(res);
    expect(error.error.type).toBe('invalid_request_error');
    expect(error.error.message).toContain('session_archived');
  });

  it('running 会话更新 agent.tools 返回 409(session_not_idle);title 不受限', async () => {
    const created = await createDefaultSession();
    await setSessionStatusInDb(created.id, 'running');

    const tools = await updateSession(created.id, { agent: { tools: [] } });
    expect(tools.status).toBe(409);
    expect((await jsonBody<ErrorEnvelope>(tools)).error.message).toContain('session_not_idle');

    const title = await jsonBody<SessionJson>(
      await updateSession(created.id, { title: 'still ok' }),
    );
    expect(title.title).toBe('still ok');
  });

  it('不存在的 id 返回 404', async () => {
    const res = await updateSession('sess_00000000-0000-7000-8000-000000000000', { title: 'x' });
    expect(res.status).toBe(404);
  });
});
