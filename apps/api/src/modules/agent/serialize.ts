import type { AgentRow, AgentVersionRow } from "@nano/db";
import type {
  AgentResponse,
  ModelEffort,
  ModelId,
  NormalizedAgentConfig,
} from "@nano/shared";

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

/**
 * 数据库行 → 归一化配置。
 * 模型三列以文本存储,断言回协议枚举:落库的值都经过归一化,只会是合法取值。
 * service 的更新链路也用它把当前版本行还原成合并基线。
 */
export function versionRowToConfig(row: AgentVersionRow): NormalizedAgentConfig {
  return {
    name: row.name,
    description: row.description,
    system: row.system,
    model: {
      id: row.modelId as ModelId,
      effort: row.modelEffort as ModelEffort,
      speed: row.modelSpeed as "standard",
    },
    tools: row.tools,
    skills: row.skills,
    mcp_servers: row.mcpServers,
    metadata: row.metadata,
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
