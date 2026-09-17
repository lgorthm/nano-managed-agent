/**
 * Agent 资源类型。见 references/agent-setup.md 与 references/api/{list,create,update}-agent.md。
 */
import type { Metadata } from './common';

export type GlmModelId = 'glm-5.3' | 'glm-5.3-flash';

export type ModelEffort = 'low' | 'high' | 'max';

/** 模型配置:接受 ID 字符串或对象形态 */
export type ModelInput =
  | GlmModelId
  | {
      id: GlmModelId;
      /** 省略或 null 时取该模型默认档位(glm-5.3:max / glm-5.3-flash:high) */
      effort?: ModelEffort | null;
      /** 当前仅支持 standard */
      speed?: 'standard' | null;
    };

/** 响应中的模型配置,服务端补齐后的完整形态 */
export interface ModelResponse {
  id: string;
  effort?: ModelEffort;
  speed: 'standard';
}

export type PermissionPolicyType = 'always_allow' | 'always_ask';

export interface PermissionPolicy {
  type: PermissionPolicyType;
}

export type BuiltinToolName = 'read' | 'write' | 'edit' | 'bash' | 'grep' | 'find' | 'ls';

export interface ToolDefaultConfigInput {
  /** 省略或 null 时为 true */
  enabled?: boolean | null;
  /** 省略或 null 时为 always_allow */
  permission_policy?: PermissionPolicy | null;
}

export interface ToolDefaultConfigResponse {
  enabled: boolean;
  permission_policy: PermissionPolicy;
}

export interface BuiltinToolConfigInput {
  name: BuiltinToolName;
  /** 省略或 null 时继承 default_config */
  enabled?: boolean | null;
  permission_policy?: PermissionPolicy | null;
}

export interface BuiltinToolConfigResponse {
  name: BuiltinToolName;
  enabled: boolean;
  permission_policy: PermissionPolicy;
}

export interface McpToolConfigInput {
  name: string;
  enabled?: boolean | null;
  permission_policy?: PermissionPolicy | null;
}

export interface McpToolConfigResponse {
  name: string;
  enabled: boolean;
  permission_policy: PermissionPolicy;
}

export interface CustomToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export type ToolsetInput =
  | {
      type: 'agent_toolset_20260601';
      default_config?: ToolDefaultConfigInput | null;
      configs?: BuiltinToolConfigInput[];
    }
  | {
      type: 'mcp_toolset';
      /** 必须精确匹配 mcp_servers 中唯一一个 Server 的 name */
      mcp_server_name: string;
      default_config?: ToolDefaultConfigInput | null;
      configs?: McpToolConfigInput[];
    }
  | {
      type: 'custom';
      name: string;
      description: string;
      input_schema: CustomToolInputSchema;
    };

export type ToolsetResponse =
  | {
      type: 'agent_toolset_20260601';
      default_config: ToolDefaultConfigResponse;
      configs: BuiltinToolConfigResponse[];
    }
  | {
      type: 'mcp_toolset';
      mcp_server_name: string;
      default_config: ToolDefaultConfigResponse;
      configs: McpToolConfigResponse[];
    }
  | {
      type: 'custom';
      name: string;
      description: string;
      input_schema: CustomToolInputSchema;
    };

export interface SkillReference {
  /** custom:当前所有者创建;zai:平台内置 */
  type: 'custom' | 'zai';
  skill_id: string;
  version: string;
}

/** 远程 MCP Server 声明,当前仅支持 url 型 */
export interface McpServer {
  type: 'url';
  name: string;
  url: string;
}

export interface Agent {
  id: string;
  type: 'agent';
  name: string;
  description: string | null;
  model: ModelResponse;
  system: string | null;
  tools: ToolsetResponse[];
  skills: SkillReference[];
  mcp_servers: McpServer[];
  metadata: Metadata;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface AgentCreateInput {
  name: string;
  model: ModelInput;
  system?: string | null;
  description?: string | null;
  tools?: ToolsetInput[];
  skills?: SkillReference[];
  mcp_servers?: McpServer[];
  metadata?: Metadata;
}

/**
 * 更新语义:省略的字段保持不变;数组字段整体替换(可传 null 清空);
 * metadata 按键级合并。带 version 时发生并发修改返回 409。
 */
export interface AgentUpdateInput {
  version?: number;
  name?: string;
  model?: ModelInput;
  system?: string | null;
  description?: string | null;
  tools?: ToolsetInput[] | null;
  skills?: SkillReference[] | null;
  mcp_servers?: McpServer[] | null;
  metadata?: Metadata;
}
