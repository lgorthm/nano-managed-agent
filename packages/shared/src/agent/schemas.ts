/**
 * Agent 资源的协议层定义(创建侧),以 docs/agent/api/create-agent.md 的 OpenAPI 为准。
 * 所有 schema 均 strict(拒绝未知键,对应 additionalProperties: false)。
 */
import { z } from "zod";

// ---------- 枚举与常量 ----------

export const MODEL_IDS = ["glm-5.3", "glm-5.3-flash"] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const MODEL_EFFORTS = ["low", "high", "max"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

/** 各模型的默认推理强度;省略或传 null 时使用 */
export const DEFAULT_MODEL_EFFORT: Record<ModelId, ModelEffort> = {
  "glm-5.3": "max",
  "glm-5.3-flash": "high",
};

export const BUILTIN_TOOLSET_TYPE = "agent_toolset_20260601" as const;

export const BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

// ---------- 工具与权限 ----------

export const PermissionPolicySchema = z.strictObject({
  type: z.enum(["always_allow", "always_ask"]),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;

/** 工具集默认配置;省略或 null 表示取默认(enabled=true、always_allow) */
export const ToolDefaultConfigInputSchema = z.strictObject({
  enabled: z.boolean().nullish(),
  permission_policy: PermissionPolicySchema.nullish(),
});

/** 内置工具的逐工具覆盖;省略的字段继承 default_config */
export const BuiltinToolConfigInputSchema = z.strictObject({
  name: z.enum(BUILTIN_TOOL_NAMES),
  enabled: z.boolean().nullish(),
  permission_policy: PermissionPolicySchema.nullish(),
});

/** MCP 工具的逐工具覆盖;name 是 Server 实际公开的工具名 */
export const McpToolConfigInputSchema = z.strictObject({
  name: z.string().min(1),
  enabled: z.boolean().nullish(),
  permission_policy: PermissionPolicySchema.nullish(),
});

/** 自定义工具的 input_schema;固定 type=object,其余字段透传(additionalProperties: true) */
export const CustomToolInputSchema = z.looseObject({
  type: z.literal("object"),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});
export type CustomToolInput = z.infer<typeof CustomToolInputSchema>;

// ---------- Skill 引用与 MCP Server ----------

export const SkillReferenceSchema = z.strictObject({
  type: z.enum(["custom", "zai"]),
  skill_id: z.string().min(1),
  version: z.string().min(1),
});
export type SkillReference = z.infer<typeof SkillReferenceSchema>;

/** 校验 MCP Server URL:公开 HTTPS、无凭据、无 fragment、无空 query、非旧式 SSE 路径 */
function checkMcpUrl(url: string): string | null {
  if (!url.startsWith("https://")) return "must start with https://";
  if (url.length > 2048) return "must be at most 2048 characters";
  const rest = url.slice("https://".length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority.includes("@")) return "must not contain credentials";
  if (url.includes("#")) return "must not contain a fragment";
  const queryStart = url.indexOf("?");
  if (queryStart !== -1) {
    const query = url.slice(queryStart + 1);
    if (query === "" || query.startsWith("&")) return "must not contain an empty query";
  }
  const pathEnd = queryStart === -1 ? url.length : queryStart;
  const path = rest.slice(authority.length, pathEnd - "https://".length);
  if (/\/sse\/?$/.test(path)) return "must not use the legacy SSE path";
  return null;
}

export const McpServerSchema = z.strictObject({
  type: z.literal("url"),
  name: z.string().min(1).max(255),
  url: z.string().superRefine((url, ctx) => {
    const problem = checkMcpUrl(url);
    if (problem) ctx.addIssue({ code: "custom", message: `Invalid MCP server URL: ${problem}.` });
  }),
});
export type McpServer = z.infer<typeof McpServerSchema>;

// ---------- 模型与工具集 ----------

/** 模型 ID 字符串简写,或包含 effort/speed 的对象形态 */
export const ModelInputSchema = z.union([
  z.enum(MODEL_IDS),
  z.strictObject({
    id: z.enum(MODEL_IDS),
    effort: z.enum(MODEL_EFFORTS).nullish(),
    speed: z.literal("standard").nullish(),
  }),
]);
export type ModelInput = z.infer<typeof ModelInputSchema>;

export const BuiltinToolsetInputSchema = z.strictObject({
  type: z.literal(BUILTIN_TOOLSET_TYPE),
  default_config: ToolDefaultConfigInputSchema.nullish(),
  configs: z.array(BuiltinToolConfigInputSchema).max(128).default([]),
});

export const McpToolsetInputSchema = z.strictObject({
  type: z.literal("mcp_toolset"),
  mcp_server_name: z.string().min(1),
  default_config: ToolDefaultConfigInputSchema.nullish(),
  configs: z.array(McpToolConfigInputSchema).max(128).default([]),
});

export const CustomToolsetInputSchema = z.strictObject({
  type: z.literal("custom"),
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "must match ^[A-Za-z0-9_-]+$"),
  description: z.string().min(1).max(4096),
  input_schema: CustomToolInputSchema,
});

export const AgentToolsetInputSchema = z.union([
  BuiltinToolsetInputSchema,
  McpToolsetInputSchema,
  CustomToolsetInputSchema,
]);
export type AgentToolsetInput = z.infer<typeof AgentToolsetInputSchema>;

// ---------- 元数据 ----------

/** 键值均受长度限制,最多 16 个键 */
export const MetadataSchema = z
  .record(z.string().max(64), z.string().max(512))
  .refine((metadata) => Object.keys(metadata).length <= 16, {
    message: "metadata must have at most 16 keys",
  });

// ---------- 跨字段校验 ----------

/**
 * 跨字段规则,创建与更新(M4)共用:
 * - mcp_servers 名称唯一,且每个 Server 与每个 mcp_toolset 按名称一一对应
 * - skills 非空时必须包含 agent_toolset_20260601
 * - 同一 (type, skill_id, version) 组合不得重复
 * - custom 工具名不以 mcp__ 开头且配置内唯一
 * - 同一工具集内 configs[].name 不得重复
 */
export function refineAgentToolConfig(
  config: { tools: AgentToolsetInput[]; skills: SkillReference[]; mcp_servers: McpServer[] },
  ctx: z.RefinementCtx,
): void {
  const addIssue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });

  const serverNames = config.mcp_servers.map((server) => server.name);
  if (new Set(serverNames).size !== serverNames.length) {
    addIssue(["mcp_servers"], "mcp_servers names must be unique within the configuration");
  }

  const mcpToolsets = config.tools.filter(
    (toolset): toolset is z.infer<typeof McpToolsetInputSchema> => toolset.type === "mcp_toolset",
  );
  for (const name of new Set(serverNames)) {
    const count = mcpToolsets.filter((toolset) => toolset.mcp_server_name === name).length;
    if (count !== 1) {
      addIssue(
        ["mcp_servers"],
        `server "${name}" must be referenced by exactly one mcp_toolset (found ${count})`,
      );
    }
  }
  for (const toolset of mcpToolsets) {
    if (!serverNames.includes(toolset.mcp_server_name)) {
      addIssue(
        ["tools"],
        `mcp_toolset references unknown mcp_server_name "${toolset.mcp_server_name}"`,
      );
    }
  }

  if (config.skills.length > 0 && !config.tools.some((toolset) => toolset.type === BUILTIN_TOOLSET_TYPE)) {
    addIssue(["skills"], "configuring skills requires agent_toolset_20260601 in tools");
  }

  const seenSkills = new Set<string>();
  for (const skill of config.skills) {
    const key = `${skill.type}/${skill.skill_id}/${skill.version}`;
    if (seenSkills.has(key)) {
      addIssue(["skills"], `duplicate skill reference "${skill.skill_id}" at version "${skill.version}"`);
    }
    seenSkills.add(key);
  }

  const customNames = new Set<string>();
  for (const toolset of config.tools) {
    if (toolset.type !== "custom") continue;
    if (toolset.name.startsWith("mcp__")) {
      addIssue(["tools"], `custom tool name "${toolset.name}" must not start with "mcp__"`);
    }
    if (customNames.has(toolset.name)) {
      addIssue(["tools"], `duplicate custom tool name "${toolset.name}"`);
    }
    customNames.add(toolset.name);
  }

  for (const toolset of config.tools) {
    if (toolset.type === "custom") continue;
    const names = toolset.configs.map((config) => config.name);
    if (new Set(names).size !== names.length) {
      addIssue(
        ["tools"],
        `duplicate config name within a ${toolset.type === "mcp_toolset" ? `mcp_toolset "${toolset.mcp_server_name}"` : toolset.type}`,
      );
    }
  }
}

// ---------- 请求 schema ----------

/** 创建 Agent 的请求体 */
export const AgentCreateRequestSchema = z
  .strictObject({
    name: z.string().min(1).max(256),
    model: ModelInputSchema,
    system: z.string().max(100000).nullish(),
    description: z.string().max(2048).nullish(),
    tools: z.array(AgentToolsetInputSchema).max(128).default([]),
    skills: z.array(SkillReferenceSchema).max(20).default([]),
    mcp_servers: z.array(McpServerSchema).max(20).default([]),
    metadata: MetadataSchema.default({}),
  })
  .superRefine(refineAgentToolConfig);

export type AgentCreateRequestInput = z.output<typeof AgentCreateRequestSchema>;
