import type {
  Environment,
  EnvironmentCreateInput,
  EnvironmentDeleted,
  EnvironmentListQuery,
  EnvironmentUpdateInput,
} from '@nano/shared/glm';
import { glmFetch, glmFetchPage } from './client';

const BASE = '/agent/managed/v1/environments';

export function listEnvironments(query: EnvironmentListQuery = {}) {
  return glmFetchPage<Environment>(BASE, query);
}

export function getEnvironment(environmentId: string) {
  return glmFetch<Environment>(`${BASE}/${environmentId}`);
}

export function createEnvironment(input: EnvironmentCreateInput) {
  return glmFetch<Environment>(BASE, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** config 整体替换;已归档环境会被服务端拒绝(400) */
export function updateEnvironment(environmentId: string, input: EnvironmentUpdateInput) {
  return glmFetch<Environment>(`${BASE}/${environmentId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 归档后不能再绑定新 Session/Deployment,不可逆(无恢复接口) */
export function archiveEnvironment(environmentId: string) {
  return glmFetch<Environment>(`${BASE}/${environmentId}/archive`, {
    method: 'POST',
  });
}

/** 无引用计数:仍引用它的 Session/Deployment 在下一次使用时才会报 not found */
export function deleteEnvironment(environmentId: string) {
  return glmFetch<EnvironmentDeleted>(`${BASE}/${environmentId}`, {
    method: 'DELETE',
  });
}
