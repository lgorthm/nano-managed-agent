/**
 * 归一化:把允许大量省略的输入补全为完全展开的形态。
 * 输出同时是落库形态与 API 响应形态(见 docs/agent/schema.md 的"落库即归一化"原则):
 * - model 字符串简写展开,effort 按模型默认档位补全,speed 补为 standard
 * - 工具集 default_config 补全为 { enabled: true, permission_policy: always_allow }
 * - configs 中省略/null 的字段继承(已解析的)default_config
 */
import type {
  AgentCreateRequestInput,
  AgentToolsetInput,
  CustomToolInput,
  McpServer,
  ModelEffort,
  ModelId,
  ModelInput,
  PermissionPolicy,
  SkillReference,
  ToolDefaultConfigInputSchema,
} from "./schemas";
import { DEFAULT_MODEL_EFFORT } from "./schemas";
import type { z } from "zod";

export interface NormalizedModel {
  id: ModelId;
  effort: ModelEffort;
  speed: "standard";
}

export interface NormalizedToolConfig {
  enabled: boolean;
  permission_policy: PermissionPolicy;
}

export interface NormalizedBuiltinToolset {
  type: "agent_toolset_20260601";
  default_config: NormalizedToolConfig;
  configs: Array<NormalizedToolConfig & { name: string }>;
}

export interface NormalizedMcpToolset {
  type: "mcp_toolset";
  mcp_server_name: string;
  default_config: NormalizedToolConfig;
  configs: Array<NormalizedToolConfig & { name: string }>;
}

export interface NormalizedCustomTool {
  type: "custom";
  name: string;
  description: string;
  input_schema: CustomToolInput;
}

export type NormalizedAgentToolset =
  | NormalizedBuiltinToolset
  | NormalizedMcpToolset
  | NormalizedCustomTool;

export interface NormalizedAgentConfig {
  name: string;
  model: NormalizedModel;
  system: string | null;
  description: string | null;
  tools: NormalizedAgentToolset[];
  skills: SkillReference[];
  mcp_servers: McpServer[];
  metadata: Record<string, string>;
}

/** Agent 的 API 响应形状(docs/agent/api/create-agent.md 的 ManagedAgent) */
export interface AgentResponse {
  id: string;
  type: "agent";
  name: string;
  description: string | null;
  model: NormalizedModel;
  system: string | null;
  tools: NormalizedAgentToolset[];
  skills: SkillReference[];
  mcp_servers: McpServer[];
  metadata: Record<string, string>;
  multiagent: null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function normalizeModel(model: ModelInput): NormalizedModel {
  if (typeof model === "string") {
    return { id: model, effort: DEFAULT_MODEL_EFFORT[model], speed: "standard" };
  }
  return {
    id: model.id,
    effort: model.effort ?? DEFAULT_MODEL_EFFORT[model.id],
    speed: model.speed ?? "standard",
  };
}

function fallbackDefault(): NormalizedToolConfig {
  return { enabled: true, permission_policy: { type: "always_allow" } };
}

function normalizeDefaultConfig(
  input: z.infer<typeof ToolDefaultConfigInputSchema> | null | undefined,
): NormalizedToolConfig {
  if (!input) return fallbackDefault();
  return {
    enabled: input.enabled ?? true,
    permission_policy: input.permission_policy ?? { type: "always_allow" },
  };
}

function inheritDefault(
  input: { enabled?: boolean | null; permission_policy?: PermissionPolicy | null },
  base: NormalizedToolConfig,
): NormalizedToolConfig {
  return {
    enabled: input.enabled ?? base.enabled,
    permission_policy: input.permission_policy ?? base.permission_policy,
  };
}

function normalizeToolset(toolset: AgentToolsetInput): NormalizedAgentToolset {
  if (toolset.type === "custom") {
    return {
      type: "custom",
      name: toolset.name,
      description: toolset.description,
      input_schema: toolset.input_schema,
    };
  }
  const defaultConfig = normalizeDefaultConfig(toolset.default_config);
  const configs = toolset.configs.map((config) => ({
    name: config.name,
    ...inheritDefault(config, defaultConfig),
  }));
  if (toolset.type === "mcp_toolset") {
    return { type: "mcp_toolset", mcp_server_name: toolset.mcp_server_name, default_config: defaultConfig, configs };
  }
  return { type: toolset.type, default_config: defaultConfig, configs };
}

/** 把校验通过的创建请求归一化为落库形态 */
export function normalizeAgentConfig(input: AgentCreateRequestInput): NormalizedAgentConfig {
  return {
    name: input.name,
    model: normalizeModel(input.model),
    system: input.system ?? null,
    description: input.description ?? null,
    tools: input.tools.map(normalizeToolset),
    skills: input.skills,
    mcp_servers: input.mcp_servers,
    metadata: input.metadata,
  };
}
