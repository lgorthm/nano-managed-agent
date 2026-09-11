import type {
  Deployment,
  DeploymentCreateInput,
  DeploymentRun,
  DeploymentRunListQuery,
  ListQuery,
} from "@nano/shared/glm";
import { glmFetch, glmFetchPage } from "./client";

const BASE = "/agent/managed/v1/deployments";

export function listDeployments(query: ListQuery = {}) {
  return glmFetchPage<Deployment>(BASE, query);
}

export function getDeployment(deploymentId: string) {
  return glmFetch<Deployment>(`${BASE}/${deploymentId}`);
}

export function createDeployment(input: DeploymentCreateInput) {
  return glmFetch<Deployment>(BASE, { method: "POST", body: JSON.stringify(input) });
}

export function pauseDeployment(deploymentId: string) {
  return glmFetch<Deployment>(`${BASE}/${deploymentId}/pause`, { method: "POST" });
}

export function resumeDeployment(deploymentId: string) {
  return glmFetch<Deployment>(`${BASE}/${deploymentId}/unpause`, { method: "POST" });
}

/** 手动触发一次运行 */
export function runDeployment(deploymentId: string) {
  return glmFetch<DeploymentRun>(`${BASE}/${deploymentId}/run`, { method: "POST" });
}

export function listDeploymentRuns(query: DeploymentRunListQuery = {}) {
  return glmFetchPage<DeploymentRun>("/agent/managed/v1/deployment_runs", query);
}
