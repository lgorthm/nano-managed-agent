import type { SessionResourceRow, SessionRow } from "@nano/db";
import type { FileResourceResponse, SessionAgentResponse, SessionResponse } from "@nano/shared";

/**
 * Session 行到 API JSON 的唯一序列化出口:
 * 时间戳转 ISO 8601 UTC,注入一期固定回显字段(vault_ids/outcome_evaluations/
 * stats/budget 与 agent.type/agent.multiagent),resources 由调用方以子查询拼装。
 * 十个端点共用,保证回显形状一致。
 */
export function serializeSession(session: SessionRow, resources: SessionResourceRow[]): SessionResponse {
  const agent: SessionAgentResponse = {
    id: session.agentId,
    type: "agent",
    ...session.agentConfig,
    multiagent: null,
    version: session.agentVersion,
  };
  return {
    id: session.id,
    type: "session",
    agent,
    environment_id: session.environmentId,
    status: session.status,
    title: session.title,
    metadata: session.metadata,
    resources: resources.map(serializeSessionResource),
    vault_ids: [],
    outcome_evaluations: [],
    stats: { active_seconds: 0, duration_seconds: 0 },
    usage: {
      input_tokens: session.inputTokens,
      output_tokens: session.outputTokens,
      cache_read_input_tokens: session.cacheReadInputTokens,
    },
    budget: null,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
    archived_at: session.archivedAt?.toISOString() ?? null,
  };
}

/** 挂载资源行 → FileResourceResponse(创建路径由已知值构造,同样经此函数保证形状) */
export function serializeSessionResource(row: {
  id: string;
  fileId: string;
  mountPath: string;
  createdAt: Date;
  updatedAt: Date;
}): FileResourceResponse {
  return {
    id: row.id,
    type: "file",
    file_id: row.fileId,
    mount_path: row.mountPath,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
