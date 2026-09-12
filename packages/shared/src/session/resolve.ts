/**
 * 会话侧的 Agent 引用解析(docs/session/schema.md 的"创建即冻结"原则):
 * 钉住的 agent_versions 配置 ⊕ 会话级覆盖 → 会话持有的最终配置快照。
 * 覆盖按字段整体替换(非深合并):省略继承版本、null 与空数组清空——
 * 与 Agent 更新语义(merge.ts)同款规则,但作用对象是版本快照而非补丁请求。
 * 输出即落库形态(agent_config 列)与 wire 回显形态(session.agent),读取时零加工。
 */
import type {
  AgentToolsetInput,
  McpServer,
  ModelInput,
  SkillReference,
} from "../agent/schemas";
import type { NormalizedAgentConfig } from "../agent/normalize";
import { normalizeModel, normalizeToolset } from "../agent/normalize";

/**
 * 会话持有的 Agent 配置快照:NormalizedAgentConfig 去掉 metadata——
 * wire 的 session.agent 不回显 metadata,会话自身的 metadata 是另一个字段。
 */
export type SessionAgentConfig = Omit<NormalizedAgentConfig, "metadata">;

/** agent_with_overrides 的覆盖字段;全部"省略继承 / null 清空" */
export interface SessionAgentOverrides {
  model?: ModelInput;
  system?: string | null;
  tools?: AgentToolsetInput[] | null;
  skills?: SkillReference[] | null;
  mcp_servers?: McpServer[] | null;
}

/** 版本行配置 → 快照形态(去掉 metadata);创建解析的第一步 */
export function toSessionAgentConfig(config: NormalizedAgentConfig): SessionAgentConfig {
  return {
    name: config.name,
    model: config.model,
    system: config.system,
    description: config.description,
    tools: config.tools,
    skills: config.skills,
    mcp_servers: config.mcp_servers,
  };
}

/**
 * 把覆盖合并进基准快照。base 即当前事实(创建时是钉住的版本配置,
 * 更新时是会话已固化的快照),overrides 中未提及的字段原样保留;
 * 替换进来的 model 与 tools 先归一化再合并,保证结果与基准同为归一化形态。
 */
export function resolveSessionAgent(
  base: SessionAgentConfig,
  overrides?: SessionAgentOverrides,
): SessionAgentConfig {
  if (!overrides) return base;
  return {
    name: base.name,
    description: base.description,
    model: overrides.model === undefined ? base.model : normalizeModel(overrides.model),
    system: overrides.system === undefined ? base.system : overrides.system ?? null,
    tools:
      overrides.tools === undefined ? base.tools : overrides.tools === null ? [] : overrides.tools.map(normalizeToolset),
    skills: overrides.skills === undefined ? base.skills : overrides.skills ?? [],
    mcp_servers: overrides.mcp_servers === undefined ? base.mcp_servers : overrides.mcp_servers ?? [],
  };
}
