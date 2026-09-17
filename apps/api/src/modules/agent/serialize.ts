import { type AgentRow, type AgentVersionRow, agentVersionRowToConfig } from '@nano/db';
import type { AgentResponse, NormalizedAgentConfig } from '@nano/shared';

/** 行 → 配置的映射上提到 @nano/db(与会话模块的引用解析共用),此处保留原导入名 */
export const versionRowToConfig = agentVersionRowToConfig;

/**
 * 版本配置到 API JSON 的唯一序列化出口:
 * 时间戳转 ISO 8601 UTC,注入不落库的固定字段 type/multiagent。
 * 六个端点共用,保证回显形状一致。
 */
export function serializeAgent(meta: {
  id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  config: NormalizedAgentConfig;
}): AgentResponse {
  return {
    id: meta.id,
    type: 'agent',
    name: meta.config.name,
    description: meta.config.description,
    model: meta.config.model,
    system: meta.config.system,
    tools: meta.config.tools,
    skills: meta.config.skills,
    mcp_servers: meta.config.mcp_servers,
    metadata: meta.config.metadata,
    multiagent: null,
    version: meta.version,
    created_at: meta.createdAt.toISOString(),
    updated_at: meta.updatedAt.toISOString(),
    archived_at: meta.archivedAt?.toISOString() ?? null,
  };
}

/** agents 行 + 当前版本行 → Agent 响应(读取路径的序列化入口) */
export function serializeAgentRow(agent: AgentRow, version: AgentVersionRow): AgentResponse {
  return serializeAgent({
    id: agent.id,
    version: agent.currentVersion,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    archivedAt: agent.archivedAt,
    config: versionRowToConfig(version),
  });
}
