import type {
  Deployment,
  DeploymentCreateInput,
  DeploymentRun,
  DeploymentRunListQuery,
  DeploymentUpdateInput,
  ListQuery,
} from '@nano/shared/glm';
import { glmFetch, glmFetchPage } from './client';

const BASE = '/agent/managed/v1/deployments';

export function listDeployments(query: ListQuery = {}) {
  return glmFetchPage<Deployment>(BASE, query);
}

export function getDeployment(deploymentId: string) {
  return glmFetch<Deployment>(`${BASE}/${deploymentId}`);
}

export function createDeployment(input: DeploymentCreateInput) {
  return glmFetch<Deployment>(BASE, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 至少带一个字段;agent 只能重新固定同一个 Agent 的版本 */
export function updateDeployment(deploymentId: string, input: DeploymentUpdateInput) {
  return glmFetch<Deployment>(`${BASE}/${deploymentId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 幂等的终态操作;归档后不再触发调度 */
export function archiveDeployment(deploymentId: string) {
  return glmFetch<Deployment>(`${BASE}/${deploymentId}/archive`, {
    method: 'POST',
  });
}

export function pauseDeployment(deploymentId: string) {
  return glmFetch<Deployment>(`${BASE}/${deploymentId}/pause`, {
    method: 'POST',
  });
}

export function resumeDeployment(deploymentId: string) {
  return glmFetch<Deployment>(`${BASE}/${deploymentId}/unpause`, {
    method: 'POST',
  });
}

/** 手动触发一次运行 */
export function runDeployment(deploymentId: string) {
  return glmFetch<DeploymentRun>(`${BASE}/${deploymentId}/run`, {
    method: 'POST',
  });
}

export function listDeploymentRuns(query: DeploymentRunListQuery = {}) {
  return glmFetchPage<DeploymentRun>('/agent/managed/v1/deployment_runs', query);
}

/** 单次运行的完整详情 */
export function getDeploymentRun(runId: string) {
  return glmFetch<DeploymentRun>(`/agent/managed/v1/deployment_runs/${runId}`);
}
