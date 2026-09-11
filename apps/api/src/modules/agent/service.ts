import { createAgentWithFirstVersion, getDb, newAgentId } from "@nano/db";
import type { AgentCreateRequestInput, AgentResponse } from "@nano/shared";
import { normalizeAgentConfig } from "@nano/shared";
import type { Env } from "../../env";
import { serializeAgent } from "./serialize";

/**
 * Agent 资源的业务编排层。
 * createAgent:校验(handler 已完成)→ 归一化 → 生成 ID → 落库 → 以落库形态回显。
 */
export const agentService = {
  async createAgent(env: Env, input: AgentCreateRequestInput): Promise<AgentResponse> {
    const config = normalizeAgentConfig(input);
    const db = getDb(env);
    const id = newAgentId();
    const now = new Date();
    await createAgentWithFirstVersion(db, { id, config, now });
    return serializeAgent({ id, version: 1, createdAt: now, updatedAt: now, archivedAt: null, config });
  },
};
