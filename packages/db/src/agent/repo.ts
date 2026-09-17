/**
 * Agent 资源的仓储函数:全部 SQL 的唯一出处。
 * 事务边界收敛在这里——多条语句放进同一个 D1 batch(隐式事务)。
 */

import type { ModelEffort, ModelId, NormalizedAgentConfig } from '@nano/shared';
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { agents, agentVersions } from '../schema';

export type AgentRow = typeof agents.$inferSelect;
export type AgentVersionRow = typeof agentVersions.$inferSelect;

/** agents 行 + 当前版本快照,是获取/更新/归档三类操作的共同读取形态 */
export interface CurrentAgent {
  agent: AgentRow;
  version: AgentVersionRow;
}

/**
 * 版本行 → 归一化配置。模型三列以文本存储,断言回协议枚举:
 * 落库的值都经过归一化,只会是合法取值。
 * agent 模块的序列化与会话模块的引用解析共用此映射(单一出处)。
 */
export function agentVersionRowToConfig(row: AgentVersionRow): NormalizedAgentConfig {
  return {
    name: row.name,
    description: row.description,
    system: row.system,
    model: {
      id: row.modelId as ModelId,
      effort: row.modelEffort as ModelEffort,
      speed: row.modelSpeed as 'standard',
    },
    tools: row.tools,
    skills: row.skills,
    mcp_servers: row.mcpServers,
    metadata: row.metadata,
  };
}

/** 归一化配置 → agent_versions 列值 */
function versionValues(agentId: string, version: number, config: NormalizedAgentConfig, now: Date) {
  return {
    agentId,
    version,
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
  };
}

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
    db.insert(agentVersions).values(versionValues(id, 1, config, now)),
  ]);
}

/** 按 id 取 agents 行并以 current_version 关联取当前配置快照;查不到返回 null */
export async function findCurrentAgent(db: Db, agentId: string): Promise<CurrentAgent | null> {
  const rows = await db
    .select({ agent: agents, version: agentVersions })
    .from(agents)
    .innerJoin(
      agentVersions,
      and(eq(agentVersions.agentId, agents.id), eq(agentVersions.version, agents.currentVersion)),
    )
    .where(eq(agents.id, agentId))
    .limit(1);
  return rows[0] ?? null;
}

/** 列表页游标:定位到 (created_at, id) 之后/之前的位置 */
export interface AgentsPageCursor {
  createdAt: number;
  id: string;
}

/**
 * 按 (created_at, id) keyset 分页列出全部 Agent(含已归档),每行带当前版本快照。
 * 多取一行判断是否还有下一页;同一毫秒内按 id 字典序保证全序稳定。
 */
export async function listAgentsPage(
  db: Db,
  params: {
    limit: number;
    order: 'asc' | 'desc';
    cursor: AgentsPageCursor | null;
  },
): Promise<{ rows: CurrentAgent[]; nextCursor: AgentsPageCursor | null }> {
  const cursorCondition = params.cursor
    ? (() => {
        const at = new Date(params.cursor!.createdAt);
        return params.order === 'desc'
          ? or(
              lt(agents.createdAt, at),
              and(eq(agents.createdAt, at), lt(agents.id, params.cursor!.id)),
            )
          : or(
              gt(agents.createdAt, at),
              and(eq(agents.createdAt, at), gt(agents.id, params.cursor!.id)),
            );
      })()
    : undefined;

  const rows = await db
    .select({ agent: agents, version: agentVersions })
    .from(agents)
    .innerJoin(
      agentVersions,
      and(eq(agentVersions.agentId, agents.id), eq(agentVersions.version, agents.currentVersion)),
    )
    .where(cursorCondition)
    .orderBy(
      params.order === 'desc' ? desc(agents.createdAt) : asc(agents.createdAt),
      params.order === 'desc' ? desc(agents.id) : asc(agents.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? { createdAt: last.agent.createdAt.getTime(), id: last.agent.id } : null;
  return { rows: pageRows, nextCursor };
}

/** 按 id 取 agents 行(不含版本快照),用于存在性检查与 Agent 级字段(如 archived_at) */
export async function findAgentRow(db: Db, agentId: string): Promise<AgentRow | null> {
  const rows = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  return rows[0] ?? null;
}

/** 点查指定版本快照(会话钉版本用);不存在(版本号越界或 Agent 不存在)返回 null */
export async function findAgentVersion(
  db: Db,
  keys: { agentId: string; version: number },
): Promise<AgentVersionRow | null> {
  const rows = await db
    .select()
    .from(agentVersions)
    .where(and(eq(agentVersions.agentId, keys.agentId), eq(agentVersions.version, keys.version)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 按 version keyset 分页列出指定 Agent 的全部版本快照(含当前版本)。
 * 多取一行判断是否还有下一页。版本号是单调整数,单列 keyset 即可。
 */
export async function listAgentVersionsPage(
  db: Db,
  agentId: string,
  params: { limit: number; order: 'asc' | 'desc'; cursor: number | null },
): Promise<{ rows: AgentVersionRow[]; nextCursor: number | null }> {
  const agentCondition = eq(agentVersions.agentId, agentId);
  const cursorCondition =
    params.cursor === null
      ? undefined
      : params.order === 'desc'
        ? lt(agentVersions.version, params.cursor)
        : gt(agentVersions.version, params.cursor);

  const rows = await db
    .select()
    .from(agentVersions)
    .where(cursorCondition === undefined ? agentCondition : and(agentCondition, cursorCondition))
    .orderBy(params.order === 'desc' ? desc(agentVersions.version) : asc(agentVersions.version))
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return { rows: pageRows, nextCursor: hasMore && last ? last.version : null };
}

/**
 * 插入下一个版本并前移当前版本指针,乐观并发写入的原子核心。
 *
 * batch 内两条语句(整个 batch 是隐式事务,SQLite 串行化写):
 * 1. 带守卫的 INSERT ... SELECT:仅当 agents.current_version 仍等于 expected 且未归档时
 *    才插入新版本行,守卫失败则一行都不写(不会产生孤儿行,更不会覆盖已有版本——
 *    版本行是不可变快照,任何情况下都不得被改写);
 * 2. CAS 前移指针(WHERE current_version = expected AND archived_at IS NULL)。
 *
 * 任一环节条件不满足(期间被人改过/已归档),两条语句都空转,返回 false → 上层转 409/400。
 */
export async function insertNextVersionAndAdvance(
  db: Db,
  input: {
    agentId: string;
    expectedVersion: number;
    config: NormalizedAgentConfig;
    now: Date;
  },
): Promise<boolean> {
  const { agentId, expectedVersion, config, now } = input;
  const nextVersion = expectedVersion + 1;
  const results = await db.batch([
    // 带守卫的 INSERT ... SELECT:仅当 current_version 仍等于 expected 且未归档时
    // 才产出数据行,守卫失败则一行不插。SELECT 列按表顺序全部给出。
    db.insert(agentVersions).select(sql`
      SELECT
        ${agentId}, ${nextVersion}, ${config.name}, ${config.description}, ${config.system},
        ${config.model.id}, ${config.model.effort}, ${config.model.speed},
        ${JSON.stringify(config.tools)}, ${JSON.stringify(config.skills)},
        ${JSON.stringify(config.mcp_servers)}, ${JSON.stringify(config.metadata)},
        ${now.getTime()}, ${now.getTime()}
      FROM agents
      WHERE id = ${agentId} AND current_version = ${expectedVersion} AND archived_at IS NULL
    `),
    db
      .update(agents)
      .set({ currentVersion: nextVersion, updatedAt: now })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.currentVersion, expectedVersion),
          isNull(agents.archivedAt),
        ),
      ),
  ]);
  // batch 返回的第二项是 UPDATE 的结果,meta.changes 为受影响行数
  const updateResult = results[1] as unknown as { meta?: { changes?: number } };
  return (updateResult.meta?.changes ?? 0) > 0;
}

/**
 * 幂等归档:仅当未归档时写入归档时间,重复调用不改动任何数据。
 * 归档是终止操作,没有反向(取消归档)路径。
 */
export async function archiveAgent(db: Db, agentId: string, now: Date): Promise<void> {
  await db
    .update(agents)
    .set({ archivedAt: now })
    .where(and(eq(agents.id, agentId), isNull(agents.archivedAt)));
}
