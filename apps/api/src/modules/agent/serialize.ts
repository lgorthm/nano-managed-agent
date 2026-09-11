import type { AgentResponse, NormalizedAgentConfig } from "@nano/shared";

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
    type: "agent",
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
