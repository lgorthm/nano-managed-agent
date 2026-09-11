import type {
  Credential,
  CredentialCreateInput,
  CredentialDeleted,
  CredentialListQuery,
  CredentialUpdateInput,
  CredentialValidation,
  Vault,
  VaultCreateInput,
  VaultDeleted,
  VaultListQuery,
  VaultUpdateInput,
} from "@nano/shared/glm";
import { glmFetch, glmFetchPage } from "./client";

const BASE = "/agent/managed/v1/vaults";

export function listVaults(query: VaultListQuery = {}) {
  return glmFetchPage<Vault>(BASE, query);
}

export function getVault(vaultId: string) {
  return glmFetch<Vault>(`${BASE}/${vaultId}`);
}

export function createVault(input: VaultCreateInput) {
  return glmFetch<Vault>(BASE, { method: "POST", body: JSON.stringify(input) });
}

export function updateVault(vaultId: string, input: VaultUpdateInput) {
  return glmFetch<Vault>(`${BASE}/${vaultId}`, { method: "POST", body: JSON.stringify(input) });
}

/** 归档后引用它的 Session/Deployment 在下一次消费凭据的交互时失败 */
export function archiveVault(vaultId: string) {
  return glmFetch<Vault>(`${BASE}/${vaultId}/archive`, { method: "POST" });
}

export function deleteVault(vaultId: string) {
  return glmFetch<VaultDeleted>(`${BASE}/${vaultId}`, { method: "DELETE" });
}

export function listCredentials(vaultId: string, query: CredentialListQuery = {}) {
  return glmFetchPage<Credential>(`${BASE}/${vaultId}/credentials`, query);
}

/** secret 字段只写不回显;创建成功后无法再读取任何 secret */
export function createCredential(vaultId: string, input: CredentialCreateInput) {
  return glmFetch<Credential>(`${BASE}/${vaultId}/credentials`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getCredential(vaultId: string, credentialId: string) {
  return glmFetch<Credential>(`${BASE}/${vaultId}/credentials/${credentialId}`);
}

/** 只允许轮换 secret 或调整可变参数;auth type 与结构字段不可改 */
export function updateCredential(vaultId: string, credentialId: string, input: CredentialUpdateInput) {
  return glmFetch<Credential>(`${BASE}/${vaultId}/credentials/${credentialId}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteCredential(vaultId: string, credentialId: string) {
  return glmFetch<CredentialDeleted>(`${BASE}/${vaultId}/credentials/${credentialId}`, {
    method: "DELETE",
  });
}

/** 仅适用于 mcp_oauth 凭据:在线探测 MCP initialize(及可选 refresh) */
export function verifyMcpOAuth(vaultId: string, credentialId: string) {
  return glmFetch<CredentialValidation>(
    `${BASE}/${vaultId}/credentials/${credentialId}/mcp_oauth_validate`,
    { method: "POST" },
  );
}

export function archiveCredential(vaultId: string, credentialId: string) {
  return glmFetch<Credential>(`${BASE}/${vaultId}/credentials/${credentialId}/archive`, {
    method: "POST",
  });
}
