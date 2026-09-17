import type { Agent, AgentCreateInput, AgentUpdateInput, ListQuery } from '@nano/shared/glm';
import { glmFetch, glmFetchPage } from './client';

const BASE = '/agent/managed/v1/agents';

export function listAgents(query: ListQuery = {}) {
  return glmFetchPage<Agent>(BASE, query);
}

export function getAgent(agentId: string) {
  return glmFetch<Agent>(`${BASE}/${agentId}`);
}

/** 版本历史:每个条目是该版本的完整配置快照 */
export function listAgentVersions(agentId: string, query: ListQuery = {}) {
  return glmFetchPage<Agent>(`${BASE}/${agentId}/versions`, query);
}

export function createAgent(input: AgentCreateInput) {
  return glmFetch<Agent>(BASE, { method: 'POST', body: JSON.stringify(input) });
}

/** GLM 的更新语义是 POST(非 PATCH);带 version 时并发冲突返回 409 */
export function updateAgent(agentId: string, input: AgentUpdateInput) {
  return glmFetch<Agent>(`${BASE}/${agentId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function archiveAgent(agentId: string) {
  return glmFetch<Agent>(`${BASE}/${agentId}/archive`, { method: 'POST' });
}
