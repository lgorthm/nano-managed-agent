/**
 * Vault 与 Credential 类型。见 references/api/{create,list,get,update,delete,archive}-vault.md
 * 与 references/api/{create,list,get,update,delete,archive}-credential.md、verify-mcp-oauth.md。
 * Vault 是给 Agent 运行时注入凭据的金库;所有 secret 字段只写不回显。
 */
import type { ListQuery, Metadata } from "./common";
import type { MetadataPatch } from "./memory";

export interface Vault {
  type: "vault";
  id: string;
  display_name: string;
  metadata: Metadata;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface VaultListQuery extends ListQuery {
  include_archived?: boolean;
}

export interface VaultCreateInput {
  /** 1–255 个字符 */
  display_name: string;
  metadata?: Metadata;
}

export interface VaultUpdateInput {
  /** null = 清为空字符串,省略 = 保持不变 */
  display_name?: string | null;
  metadata?: MetadataPatch;
}

export interface VaultDeleted {
  id: string;
  type: "vault_deleted";
}

/** 凭据注入的出网范围(unlimited = 不限制;limited 只放行指定 host,最多 16 个) */
export type VaultNetworking =
  | { type: "unrestricted" }
  | { type: "limited"; allowed_hosts: string[] };

/** 注入位置;body 当前固定为 false(不支持请求体注入) */
export interface InjectionLocationInput {
  header?: boolean;
  body?: false;
}

/** OAuth 刷新配置(create 侧,secret 只写) */
export interface OAuthRefreshCreate {
  /** HTTPS URL */
  token_endpoint: string;
  client_id: string;
  scope?: string | null;
  /** 创建后不可修改 */
  resource?: string | null;
  refresh_token: string;
  token_endpoint_auth:
    | { type: "none" }
    | { type: "client_secret_basic" | "client_secret_post"; client_secret: string };
}

/** OAuth 刷新配置(update 侧:结构字段不可改,只允许轮换 secret / 调整 scope) */
export interface OAuthRefreshUpdate {
  scope?: string | null;
  refresh_token?: string | null;
  token_endpoint_auth?: {
    type: "client_secret_basic" | "client_secret_post";
    client_secret?: string | null;
  };
}

/** 创建凭据的 5 种认证形态,secret 字段只写不回显 */
export type CredentialAuthCreate =
  | {
      type: "mcp_oauth";
      /** HTTPS Streamable HTTP URL */
      mcp_server_url: string;
      access_token: string;
      expires_at?: string | null;
      refresh?: OAuthRefreshCreate | null;
    }
  | { type: "static_bearer"; mcp_server_url: string; token: string }
  | {
      type: "oauth";
      /** HTTPS origin,不含路径/query */
      host: string;
      access_token: string;
      expires_at?: string | null;
      refresh?: OAuthRefreshCreate | null;
    }
  | { type: "bearer"; host: string; token: string }
  | {
      type: "environment_variable";
      secret_name: string;
      secret_value: string;
      networking: VaultNetworking;
      injection_location?: InjectionLocationInput;
    };

/** 更新凭据:auth type / host / url / secret_name 等结构字段不可改,只允许轮换 secret */
export type CredentialAuthUpdate =
  | {
      type: "mcp_oauth";
      access_token?: string | null;
      expires_at?: string | null;
      refresh?: OAuthRefreshUpdate | null;
    }
  | { type: "static_bearer"; token?: string | null }
  | {
      type: "oauth";
      access_token?: string | null;
      expires_at?: string | null;
      refresh?: OAuthRefreshUpdate | null;
    }
  | { type: "bearer"; token?: string | null }
  | {
      type: "environment_variable";
      secret_value?: string | null;
      networking?: VaultNetworking | null;
      injection_location?: InjectionLocationInput;
    };

export interface CredentialCreateInput {
  display_name?: string;
  metadata?: Metadata;
  auth: CredentialAuthCreate;
}

export interface CredentialUpdateInput {
  display_name?: string | null;
  metadata?: MetadataPatch | null;
  auth?: CredentialAuthUpdate;
}

export interface OAuthRefreshResponse {
  token_endpoint: string;
  client_id: string;
  token_endpoint_auth: { type: "none" | "client_secret_basic" | "client_secret_post" };
  scope: string | null;
  resource: string | null;
}

/** 响应侧认证形态:不含任何 secret */
export type CredentialAuthResponse =
  | {
      type: "mcp_oauth";
      mcp_server_url: string | null;
      expires_at: string | null;
      refresh: OAuthRefreshResponse | null;
    }
  | { type: "static_bearer"; mcp_server_url: string | null }
  | {
      type: "oauth";
      host: string | null;
      expires_at: string | null;
      refresh: OAuthRefreshResponse | null;
    }
  | { type: "bearer"; host: string | null }
  | {
      type: "environment_variable";
      secret_name: string | null;
      networking: VaultNetworking | null;
      injection_location: { header: boolean; body: false };
    };

export interface Credential {
  type: "vault_credential";
  id: string;
  display_name: string;
  vault_id: string;
  metadata: Metadata;
  auth: CredentialAuthResponse;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface CredentialListQuery extends ListQuery {
  include_archived?: boolean;
}

export interface CredentialDeleted {
  id: string;
  type: "vault_credential_deleted";
}

export interface CapturedHttpResponse {
  status_code: number;
  content_type: string;
  body: string;
  body_truncated: boolean;
}

/** MCP OAuth 凭据的在线校验结果(探测 initialize + 可选 refresh) */
export interface CredentialValidation {
  type: "vault_credential_validation";
  credential_id: string;
  vault_id: string;
  validated_at: string;
  has_refresh_token: boolean;
  status: "valid" | "invalid" | "unknown";
  mcp_probe: { method: "initialize"; http_response: CapturedHttpResponse | null };
  refresh: {
    status: "succeeded" | "failed" | "connect_error" | "no_refresh_token";
    http_response: CapturedHttpResponse | null;
  };
}
