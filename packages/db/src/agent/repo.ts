/**
 * Agent 资源的仓储函数:全部 SQL 的唯一出处。
 * 事务边界收敛在这里——多条语句放进同一个 D1 batch(隐式事务)。
 */
import type { NormalizedAgentConfig } from "@nano/shared";
import type { Db } from "../client";
import { agentVersions, agents } from "../schema";

/** 创建 Agent 及其首个版本;两条插入在同一 batch 中原子执行 */
export async function createAgentWithFirstVersion(
  db: Db,
  input: { id: string; config: NormalizedAgentConfig; now: Date },
): Promise<void> {
  const { id, config, now } = input;
  await db.batch([
    db.insert(agents).values({
      id,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(agentVersions).values({
      agentId: id,
      version: 1,
      name: config.name,
      description: config.description,
      system: config.system,
      modelId: config.model.id,
      modelEffort: config.model.effort,
      modelSpeed: config.model.speed,
      tools: config.tools,
      skills: config.skills,
      mcpServers: config.mcp_servers,
      metadata: config.metadata,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
}
