/**
 * 契约测试:把 docs/agent/api/*.md 的 OpenAPI 约定锁成回归。
 * 字段清单以各文档的 ManagedAgent(required + multiagent)与 ErrorResponse 为准。
 */
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
  postAgent,
  updateAgent,
} from './helpers';

beforeAll(applyMigrations);

/** ManagedAgent 的完整字段集(OpenAPI additionalProperties: false,多一个少一个都算违约) */
const AGENT_KEYS = [
  'id',
  'type',
  'name',
  'description',
  'model',
  'system',
  'tools',
  'skills',
  'mcp_servers',
  'metadata',
  'multiagent',
  'version',
  'created_at',
  'updated_at',
  'archived_at',
];

/** AgentPage 的字段集 */
const PAGE_KEYS = ['data', 'next_page'];

/** 双侧都排序后比较,避免手写排序出错 */
function expectSameKeys(actual: object, expected: string[]) {
  expect(Object.keys(actual).sort()).toEqual([...expected].sort());
}

function expectAgentShape(agent: AgentJson) {
  expectSameKeys(agent, AGENT_KEYS);
  expect(agent.type).toBe('agent');
  expect(agent.multiagent).toBeNull();
  // ManagedModelResponse: { id, effort, speed },additionalProperties: false
  expect(Object.keys(agent.model).sort()).toEqual(['effort', 'id', 'speed']);
}

describe('六个端点的响应契约(docs/agent/api/*.md)', () => {
  it('POST /v1/agents → 201,响应为完整 ManagedAgent', async () => {
    const res = await postAgent({ name: 'contract-create', model: 'glm-5.3' });
    expect(res.status).toBe(201);
    expectAgentShape(await jsonBody<AgentJson>(res));
  });

  it('GET /v1/agents/{agentId} → 200,响应为完整 ManagedAgent', async () => {
    const created = await createDefaultAgent({
      name: 'contract-get',
      model: 'glm-5.3',
    });
    const res = await getAgent(created.id);
    expect(res.status).toBe(200);
    expectAgentShape(await jsonBody<AgentJson>(res));
  });

  it('GET /v1/agents → 200,响应为 { data, next_page },条目为 ManagedAgent', async () => {
    const res = await listAgents('?limit=2');
    expect(res.status).toBe(200);
    const page = await jsonBody<PageJson<AgentJson>>(res);
    expectSameKeys(page, PAGE_KEYS);
    for (const item of page.data) {
      expectAgentShape(item);
    }
  });

  it('POST /v1/agents/{agentId} → 200,响应为完整 ManagedAgent', async () => {
    const created = await createDefaultAgent({
      name: 'contract-update',
      model: 'glm-5.3',
    });
    const res = await updateAgent(created.id, { version: 1, system: 'v2' });
    expect(res.status).toBe(200);
    expectAgentShape(await jsonBody<AgentJson>(res));
  });

  it('GET /v1/agents/{agentId}/versions → 200,条目为 ManagedAgent', async () => {
    const created = await createDefaultAgent({
      name: 'contract-versions',
      model: 'glm-5.3',
    });
    const res = await listAgentVersions(created.id);
    expect(res.status).toBe(200);
    const page = await jsonBody<PageJson<AgentJson>>(res);
    expectSameKeys(page, PAGE_KEYS);
    for (const item of page.data) {
      expectAgentShape(item);
    }
  });

  it('POST /v1/agents/{agentId}/archive → 200,响应为完整 ManagedAgent', async () => {
    const created = await createDefaultAgent({
      name: 'contract-archive',
      model: 'glm-5.3',
    });
    const res = await archiveAgentViaApi(created.id);
    expect(res.status).toBe(200);
    expectAgentShape(await jsonBody<AgentJson>(res));
  });
});

describe('非 2xx 响应的错误信封契约', () => {
  async function expectEnvelope(res: Response, status: number, errorType: string) {
    expect(res.status).toBe(status);
    const envelope = await jsonBody<ErrorEnvelope>(res);
    // 信封固定三个字段
    expectSameKeys(envelope, ['error', 'request_id', 'type']);
    expect(envelope.type).toBe('error');
    expect(envelope.error.type).toBe(errorType);
    expect(typeof envelope.error.message).toBe('string');
    expect(envelope.request_id).toMatch(/^req_/);
    expect(res.headers.get('x-request-id')).toBe(envelope.request_id);
    // error 字段:details 只在携带时出现
    const errorKeys = Object.keys(envelope.error);
    expect(errorKeys).toContain('type');
    expect(errorKeys).toContain('message');
    expect(errorKeys.filter((key) => !['type', 'message', 'details'].includes(key))).toEqual([]);
    return envelope;
  }

  it('401:缺少凭证(创建端点)', async () => {
    const res = await exports.default.fetch('http://example.com/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await expectEnvelope(res, 401, 'authentication_error');
  });

  it('400:校验失败(创建缺 name)', async () => {
    const res = await postAgent({ model: 'glm-5.3' });
    const envelope = await expectEnvelope(res, 400, 'invalid_request_error');
    expect(envelope.error.details?.issues).toBeTruthy();
  });

  it('404:获取不存在的 Agent', async () => {
    const res = await getAgent('agent_01911111-1111-7111-8111-111111111111');
    await expectEnvelope(res, 404, 'not_found_error');
  });

  it('409:携带过期 version 更新', async () => {
    const created = await createDefaultAgent({
      name: 'contract-409',
      model: 'glm-5.3',
    });
    await updateAgent(created.id, { version: 1, system: 'v2' });
    const res = await updateAgent(created.id, { version: 1, system: 'stale' });
    await expectEnvelope(res, 409, 'invalid_request_error');
  });

  it('400:分页参数非法(列表 limit=0)', async () => {
    const res = await listAgents('?limit=0');
    await expectEnvelope(res, 400, 'invalid_request_error');
  });
});
