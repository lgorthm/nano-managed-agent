/**
 * Session 资源的仓储函数:全部 SQL 的唯一出处。
 * 事务边界收敛在这里——createSession 与 deleteSession 的多条语句
 * 放进同一个 D1 batch(隐式事务)。
 * "0 行受影响"的歧义(agent 不存在 / 已归档 / running)不在本层消解,
 * 统一返回 false,由 service 重读一次区分错误码。
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type {
  NormalizedEnvironmentConfig,
  SessionAgentConfig,
  SessionListFilters,
  SessionStatus,
} from "@nano/shared";
import type { Db } from "../client";
import { sessionResources, sessions } from "../schema";

export type SessionRow = typeof sessions.$inferSelect;
export type SessionResourceRow = typeof sessionResources.$inferSelect;

/** 创建会话时写入的可变业务字段(状态与用量三列走列默认值) */
export interface CreateSessionValues {
  id: string;
  agentId: string;
  agentVersion: number;
  agentConfig: SessionAgentConfig;
  environmentId: string;
  environmentSnapshot: NormalizedEnvironmentConfig;
  title: string | null;
  metadata: Record<string, string>;
}

export interface CreateSessionResourceValues {
  id: string;
  sessionId: string;
  fileId: string;
  mountPath: string;
}

/** 创建 Session 及其挂载资源;全部插入在同一 batch 中原子执行 */
export async function createSession(
  db: Db,
  input: { session: CreateSessionValues; resources: CreateSessionResourceValues[]; now: Date },
): Promise<void> {
  const { session, resources, now } = input;
  await db.batch([
    db.insert(sessions).values({
      id: session.id,
      agentId: session.agentId,
      agentVersion: session.agentVersion,
      agentConfig: session.agentConfig,
      environmentId: session.environmentId,
      environmentSnapshot: session.environmentSnapshot,
      status: "idle",
      title: session.title,
      metadata: session.metadata,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      createdAt: now,
      updatedAt: now,
    }),
    ...resources.map((resource) =>
      db.insert(sessionResources).values({
        id: resource.id,
        sessionId: resource.sessionId,
        type: "file",
        fileId: resource.fileId,
        mountPath: resource.mountPath,
        createdAt: now,
        updatedAt: now,
      }),
    ),
  ]);
}

/** 按 id 取 Session 行;查不到返回 null */
export async function findSession(db: Db, sessionId: string): Promise<SessionRow | null> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return rows[0] ?? null;
}

/** sessions 列表页游标:定位到 (created_at, id) 之后/之前的位置 */
export interface SessionsPageCursor {
  createdAt: number;
  id: string;
}

/**
 * 按过滤条件 + (created_at, id) keyset 分页列出 Session。
 * 默认排除已归档(filters.includeArchived = false),与 GLM Session 列表语义一致
 * (注意:与 agents/environments 列表"恒包含"相反)。
 */
export async function listSessionsPage(
  db: Db,
  params: {
    filters: SessionListFilters;
    limit: number;
    order: "asc" | "desc";
    cursor: SessionsPageCursor | null;
  },
): Promise<{ rows: SessionRow[]; nextCursor: SessionsPageCursor | null }> {
  const { filters } = params;
  const conditions = [
    filters.agentId !== undefined ? eq(sessions.agentId, filters.agentId) : undefined,
    filters.agentVersion !== undefined ? eq(sessions.agentVersion, filters.agentVersion) : undefined,
    filters.statuses !== undefined && filters.statuses.length > 0
      ? inArray(sessions.status, filters.statuses as SessionStatus[])
      : undefined,
    filters.createdAtGt !== undefined ? gt(sessions.createdAt, new Date(filters.createdAtGt)) : undefined,
    filters.createdAtGte !== undefined ? gte(sessions.createdAt, new Date(filters.createdAtGte)) : undefined,
    filters.createdAtLt !== undefined ? lt(sessions.createdAt, new Date(filters.createdAtLt)) : undefined,
    filters.createdAtLte !== undefined ? lte(sessions.createdAt, new Date(filters.createdAtLte)) : undefined,
    filters.includeArchived ? undefined : isNull(sessions.archivedAt),
    params.cursor
      ? (() => {
          const at = new Date(params.cursor!.createdAt);
          return params.order === "desc"
            ? or(lt(sessions.createdAt, at), and(eq(sessions.createdAt, at), lt(sessions.id, params.cursor!.id)))
            : or(
                gt(sessions.createdAt, at),
                and(eq(sessions.createdAt, at), gt(sessions.id, params.cursor!.id)),
              );
        })()
      : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(sessions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      params.order === "desc" ? desc(sessions.createdAt) : asc(sessions.createdAt),
      params.order === "desc" ? desc(sessions.id) : asc(sessions.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? { createdAt: last.createdAt.getTime(), id: last.id } : null;
  return { rows: pageRows, nextCursor };
}

/** 会话的就地覆盖字段;service 已合并出完整形态,repo 不做增量计算 */
export interface UpdateSessionValues {
  title: string | null;
  metadata: Record<string, string>;
  agentConfig: SessionAgentConfig;
}

/**
 * 守卫式就地覆盖(WHERE archived_at IS NULL 兜底并发窗口内被归档)。
 * 受影响 0 行说明行不存在或已被归档,由 service 重读一次区分 404 与 409。
 */
export async function updateSessionRow(
  db: Db,
  input: { sessionId: string; values: UpdateSessionValues; now: Date },
): Promise<boolean> {
  const result = (await db
    .update(sessions)
    .set({
      title: input.values.title,
      metadata: input.values.metadata,
      agentConfig: input.values.agentConfig,
      updatedAt: input.now,
    })
    .where(and(eq(sessions.id, input.sessionId), isNull(sessions.archivedAt)))) as unknown as {
    meta?: { changes?: number };
  };
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 归档 Session(与 Agent/Environment 相反,这里不是幂等):
 * 仅当未归档且非 running 时写入归档时间,受影响 0 行返回 false,
 * 由 service 重读区分 404(不存在)/ 409(已归档)/ 409(running)。
 */
export async function archiveSession(db: Db, sessionId: string, now: Date): Promise<boolean> {
  const result = (await db
    .update(sessions)
    .set({ archivedAt: now, updatedAt: now })
    .where(
      and(eq(sessions.id, sessionId), isNull(sessions.archivedAt), ne(sessions.status, "running")),
    )) as unknown as { meta?: { changes?: number } };
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * 硬删除会话及其挂载记录(同一 batch)。已归档会话允许删除;
 * running 拒绝(WHERE status != 'running'),受影响 0 行返回 false。
 * 挂载的 File 是独立资源,只清挂载记录,不动 files 表。
 */
export async function deleteSession(db: Db, sessionId: string): Promise<boolean> {
  const results = await db.batch([
    db.delete(sessionResources).where(eq(sessionResources.sessionId, sessionId)),
    db.delete(sessions).where(and(eq(sessions.id, sessionId), ne(sessions.status, "running"))),
  ]);
  const deleteResult = results[1] as unknown as { meta?: { changes?: number } };
  return (deleteResult.meta?.changes ?? 0) > 0;
}

/** 挂载一个 File 资源;mount_path 完全相同时 UNIQUE 约束抛错,由 service 转 400 */
export async function insertSessionResource(
  db: Db,
  resource: { id: string; sessionId: string; fileId: string; mountPath: string; now: Date },
): Promise<void> {
  await db.insert(sessionResources).values({
    id: resource.id,
    sessionId: resource.sessionId,
    type: "file",
    fileId: resource.fileId,
    mountPath: resource.mountPath,
    createdAt: resource.now,
    updatedAt: resource.now,
  });
}

/** session_resources 列表页游标 */
export interface SessionResourcesPageCursor {
  createdAt: number;
  id: string;
}

/**
 * 批量取多个会话的全部挂载资源(响应拼装用,不分页;单会话上限 500 量级,
 * 列表页 20 个会话一次取尽)。返回 session_id → 资源行,按挂载时间正序。
 */
export async function findSessionResourcesBySessionIds(
  db: Db,
  sessionIds: string[],
): Promise<Map<string, SessionResourceRow[]>> {
  const result = new Map<string, SessionResourceRow[]>();
  if (sessionIds.length === 0) return result;
  const rows = await db
    .select()
    .from(sessionResources)
    .where(inArray(sessionResources.sessionId, sessionIds))
    .orderBy(asc(sessionResources.createdAt), asc(sessionResources.id));
  for (const row of rows) {
    const list = result.get(row.sessionId);
    if (list) {
      list.push(row);
    } else {
      result.set(row.sessionId, [row]);
    }
  }
  return result;
}

/** 按 (created_at, id) keyset 分页列出会话的挂载资源;归档会话同样可列出 */
export async function listSessionResourcesPage(
  db: Db,
  params: {
    sessionId: string;
    limit: number;
    order: "asc" | "desc";
    cursor: SessionResourcesPageCursor | null;
  },
): Promise<{ rows: SessionResourceRow[]; nextCursor: SessionResourcesPageCursor | null }> {
  const conditions = [
    eq(sessionResources.sessionId, params.sessionId),
    params.cursor
      ? (() => {
          const at = new Date(params.cursor!.createdAt);
          return params.order === "desc"
            ? or(
                lt(sessionResources.createdAt, at),
                and(eq(sessionResources.createdAt, at), lt(sessionResources.id, params.cursor!.id)),
              )
            : or(
                gt(sessionResources.createdAt, at),
                and(eq(sessionResources.createdAt, at), gt(sessionResources.id, params.cursor!.id)),
              );
        })()
      : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(sessionResources)
    .where(and(...conditions))
    .orderBy(
      params.order === "desc" ? desc(sessionResources.createdAt) : asc(sessionResources.createdAt),
      params.order === "desc" ? desc(sessionResources.id) : asc(sessionResources.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? { createdAt: last.createdAt.getTime(), id: last.id } : null;
  return { rows: pageRows, nextCursor };
}

/** 按 resourceId 点查;必须属于指定 sessionId,跨会话 resourceId 视为不存在 */
export async function findSessionResource(
  db: Db,
  keys: { sessionId: string; resourceId: string },
): Promise<SessionResourceRow | null> {
  const rows = await db
    .select()
    .from(sessionResources)
    .where(and(eq(sessionResources.id, keys.resourceId), eq(sessionResources.sessionId, keys.sessionId)))
    .limit(1);
  return rows[0] ?? null;
}

/** 解除挂载;WHERE 带 session_id,跨会话 resourceId 自然落到 404 */
export async function deleteSessionResource(
  db: Db,
  keys: { sessionId: string; resourceId: string },
): Promise<boolean> {
  const result = (await db
    .delete(sessionResources)
    .where(
      and(eq(sessionResources.id, keys.resourceId), eq(sessionResources.sessionId, keys.sessionId)),
    )) as unknown as { meta?: { changes?: number } };
  return (result.meta?.changes ?? 0) > 0;
}

/** 该 File 被未归档会话挂载的次数;file 删除检查用(已归档会话的挂载不阻止删除) */
export async function countActiveSessionMounts(db: Db, fileId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(sessionResources)
    .innerJoin(sessions, eq(sessions.id, sessionResources.sessionId))
    .where(and(eq(sessionResources.fileId, fileId), isNull(sessions.archivedAt)));
  return rows[0]?.count ?? 0;
}

// ---------- 运行时投影回写(docs/session/runtime.md §8) ----------

/** turn 终局的 usage 增量;DO 状态机是事实源,D1 只做投影 */
export interface SessionUsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * SESSION_DO 回写状态投影:status 迁移即时、usage 按 turn 终局增量累计、
 * stats 随终局回写(active_seconds 按 turn 时长增量累计;duration_seconds
 * 直接取「现在 − 创建时刻」,单调不减)。
 * 不带 archived/running 守卫——归档与删除的门禁在控制面(D1)先行裁决;
 * 行不存在(会话已删)返回 false,投影丢失被容忍:事实源已随删除终结。
 */
export async function updateSessionRuntimeState(
  db: Db,
  input: {
    sessionId: string;
    status?: SessionStatus;
    usageDelta?: SessionUsageDelta;
    activeSecondsDelta?: number;
    now: Date;
  },
): Promise<boolean> {
  const delta = input.usageDelta;
  const hasUsageDelta =
    delta !== undefined &&
    (delta.inputTokens !== 0 || delta.outputTokens !== 0 || delta.cacheReadInputTokens !== 0);
  const result = (await db
    .update(sessions)
    .set({
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(hasUsageDelta && delta !== undefined
        ? {
            inputTokens: sql`${sessions.inputTokens} + ${delta.inputTokens}`,
            outputTokens: sql`${sessions.outputTokens} + ${delta.outputTokens}`,
            cacheReadInputTokens: sql`${sessions.cacheReadInputTokens} + ${delta.cacheReadInputTokens}`,
          }
        : {}),
      ...(input.activeSecondsDelta !== undefined && input.activeSecondsDelta > 0
        ? { activeSeconds: sql`${sessions.activeSeconds} + ${input.activeSecondsDelta}` }
        : {}),
      ...(input.activeSecondsDelta !== undefined
        ? { durationSeconds: sql`MAX(0.0, (CAST((julianday('now') - 2440587.5) * 86400000 AS REAL) - ${sessions.createdAt}) / 1000.0)` }
        : {}),
      updatedAt: input.now,
    })
    .where(eq(sessions.id, input.sessionId))) as unknown as { meta?: { changes?: number } };
  return (result.meta?.changes ?? 0) > 0;
}
