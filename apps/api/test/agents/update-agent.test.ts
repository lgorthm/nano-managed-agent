import { exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDefaultSkill } from '../skills/helpers';
import {
  type AgentJson,
  applyMigrations,
  archiveAgentInDb,
  bumpAgentVersionInDb,
  createDefaultAgent,
  type ErrorEnvelope,
  getAgent,
  jsonBody,
  updateAgent,
} from './helpers';

beforeAll(applyMigrations);

/** 创建一个带 skills + 内置工具集的 Agent,用于联动规则用例;引用真实 Skill(M8 后必须可解析) */
async function createWithSkills(): Promise<AgentJson> {
  const skill = await createDefaultSkill();
  return createDefaultAgent({
    name: 'with-skills',
    model: 'glm-5.3',
    tools: [{ type: 'agent_toolset_20260601' }],
    skills: [{ type: 'custom', skill_id: skill.id, version: '1' }],
  });
}

describe('POST /v1/agents/{agentId} 更新语义', () => {
  it('只改 system,其余保持不变,版本递增为 2', async () => {
    const created = await createDefaultAgent({
      name: 'Coding Assistant',
      model: 'glm-5.3',
      system: 'You are a helpful coding agent.',
      tools: [{ type: 'agent_toolset_20260601' }],
    });
    const res = await updateAgent(created.id, {
      version: 1,
      system: 'You are a helpful coding agent. Always write tests.',
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<AgentJson>(res);
    expect(body.version).toBe(2);
    expect(body.system).toBe('You are a helpful coding agent. Always write tests.');
    expect(body.name).toBe('Coding Assistant');
    expect(body.model).toEqual(created.model);
    expect(body.tools).toEqual(created.tools);
    expect(body.created_at).not.toBe(created.created_at); // 新版本有版本级时间戳
  });

  it('改 model 字符串简写后 effort 按新模型默认值补全', async () => {
    const created = await createDefaultAgent({
      name: 'switch-model',
      model: 'glm-5.3',
    });
    const res = await updateAgent(created.id, {
      version: 1,
      model: 'glm-5.3-flash',
    });
    expect(res.status).toBe(200);
    expect((await jsonBody<AgentJson>(res)).model).toEqual({
      id: 'glm-5.3-flash',
      effort: 'high',
      speed: 'standard',
    });
  });

  it('system 传 null 清空', async () => {
    const created = await createDefaultAgent({
      name: 'clear-sys',
      model: 'glm-5.3',
      system: 'to be cleared',
    });
    const res = await updateAgent(created.id, { version: 1, system: null });
    expect(res.status).toBe(200);
    expect((await jsonBody<AgentJson>(res)).system).toBeNull();
  });

  it('tools 传 [] 清空;但 skills 非空时清空 tools 被合并校验拒绝', async () => {
    const plain = await createDefaultAgent({
      name: 'plain',
      model: 'glm-5.3',
      tools: [{ type: 'agent_toolset_20260601' }],
    });
    const ok = await updateAgent(plain.id, { version: 1, tools: [] });
    expect(ok.status).toBe(200);
    expect((await jsonBody<AgentJson>(ok)).tools).toEqual([]);

    const withSkills = await createWithSkills();
    const rejected = await updateAgent(withSkills.id, {
      version: 1,
      tools: [],
    });
    expect(rejected.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(rejected);
    expect(JSON.stringify(envelope.error.details?.issues ?? [])).toContain(
      'agent_toolset_20260601',
    );
  });

  it('metadata 按键合并:null 删键、新键新增、未提及键保留', async () => {
    const created = await createDefaultAgent({
      name: 'meta',
      model: 'glm-5.3',
      metadata: { a: '1', b: '2' },
    });
    const res = await updateAgent(created.id, {
      version: 1,
      metadata: { b: null, c: '3' },
    });
    expect(res.status).toBe(200);
    expect((await jsonBody<AgentJson>(res)).metadata).toEqual({
      a: '1',
      c: '3',
    });
  });

  it('tools 与 mcp_servers 整体替换并保持一一对应', async () => {
    const created = await createDefaultAgent({ name: 'mcp', model: 'glm-5.3' });
    const res = await updateAgent(created.id, {
      version: 1,
      tools: [
        {
          type: 'agent_toolset_20260601',
          configs: [{ name: 'bash', enabled: false }],
        },
        { type: 'mcp_toolset', mcp_server_name: 'kb' },
      ],
      mcp_servers: [{ type: 'url', name: 'kb', url: 'https://mcp.example.com/mcp' }],
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<AgentJson>(res);
    expect(body.tools).toEqual([
      {
        type: 'agent_toolset_20260601',
        default_config: {
          enabled: true,
          permission_policy: { type: 'always_allow' },
        },
        configs: [
          {
            name: 'bash',
            enabled: false,
            permission_policy: { type: 'always_allow' },
          },
        ],
      },
      {
        type: 'mcp_toolset',
        mcp_server_name: 'kb',
        default_config: {
          enabled: true,
          permission_policy: { type: 'always_allow' },
        },
        configs: [],
      },
    ]);
    expect(body.mcp_servers).toEqual([
      { type: 'url', name: 'kb', url: 'https://mcp.example.com/mcp' },
    ]);
  });

  it('无变化:提交与当前一致的配置不升版本,version 与时间戳保持,响应体一致', async () => {
    const created = await createDefaultAgent({
      name: 'nochange',
      model: 'glm-5.3',
      system: 'same',
    });
    const res = await updateAgent(created.id, { version: 1, system: 'same' });
    expect(res.status).toBe(200);
    expect(await jsonBody<AgentJson>(res)).toEqual(created);

    const empty = await updateAgent(created.id, {});
    expect(empty.status).toBe(200);
    expect(await jsonBody<AgentJson>(empty)).toEqual(created);
  });
});

describe('POST /v1/agents/{agentId} 并发与版本冲突', () => {
  it('携带旧 version 在二次更新后重放返回 409', async () => {
    const created = await createDefaultAgent({
      name: 'conflict',
      model: 'glm-5.3',
    });
    const first = await updateAgent(created.id, { version: 1, system: 'v2' });
    expect(first.status).toBe(200);

    const replay = await updateAgent(created.id, {
      version: 1,
      system: 'stale write',
    });
    expect(replay.status).toBe(409);
    const envelope = await jsonBody<ErrorEnvelope>(replay);
    expect(envelope.error.type).toBe('invalid_request_error');
    expect(envelope.error.message).toContain('conflict');

    // 当前版本未被污染
    const current = await jsonBody<AgentJson>(await getAgent(created.id));
    expect(current.version).toBe(2);
    expect(current.system).toBe('v2');
  });

  it('直改库推高版本后以旧期望更新,同样返回 409 且数据不被污染', async () => {
    const created = await createDefaultAgent({
      name: 'raced',
      model: 'glm-5.3',
    });
    const raced = await bumpAgentVersionInDb(created.id);
    const res = await updateAgent(created.id, {
      version: 1,
      system: 'too late',
    });
    expect(res.status).toBe(409);
    const current = await jsonBody<AgentJson>(await getAgent(created.id));
    expect(current.version).toBe(raced);
    expect(current.name).toBe('raced-write');
  });

  it('省略 version 时覆盖式更新成功', async () => {
    const created = await createDefaultAgent({
      name: 'overwrite',
      model: 'glm-5.3',
    });
    const res = await updateAgent(created.id, { system: 'no version' });
    expect(res.status).toBe(200);
    expect((await jsonBody<AgentJson>(res)).version).toBe(2);
  });
});

describe('POST /v1/agents/{agentId} 拒绝路径', () => {
  it('已归档的 Agent 更新返回 400', async () => {
    const created = await createDefaultAgent({
      name: 'archived',
      model: 'glm-5.3',
    });
    await archiveAgentInDb(created.id);
    const res = await updateAgent(created.id, { version: 1, system: 'nope' });
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.message).toContain('archived');
  });

  it('请求含 mcp_toolset 但不带 mcp_servers 返回 400', async () => {
    const created = await createDefaultAgent({
      name: 'needs-servers',
      model: 'glm-5.3',
    });
    const res = await updateAgent(created.id, {
      version: 1,
      tools: [{ type: 'mcp_toolset', mcp_server_name: 'kb' }],
    });
    expect(res.status).toBe(400);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(JSON.stringify(envelope.error.details?.issues ?? [])).toContain('mcp_servers');
  });

  it('不存在的 id 返回 404', async () => {
    const res = await updateAgent('agent_01911111-1111-7111-8111-111111111111', { system: 'x' });
    expect(res.status).toBe(404);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe('not_found_error');
  });

  it('version 为 0 或非整数返回 400', async () => {
    const created = await createDefaultAgent({
      name: 'bad-version',
      model: 'glm-5.3',
    });
    for (const version of [0, 1.5, -1]) {
      const res = await updateAgent(created.id, { version, system: 'x' });
      expect(res.status).toBe(400);
    }
  });

  it('不带凭证返回 401', async () => {
    const created = await createDefaultAgent({
      name: 'authz',
      model: 'glm-5.3',
    });
    const res = await exports.default.fetch(`http://example.com/v1/agents/${created.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: 'x' }),
    });
    expect(res.status).toBe(401);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    expect(envelope.error.type).toBe('authentication_error');
  });
});
