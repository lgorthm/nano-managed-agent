/**
 * Environment 资源的仓储函数:全部 SQL 的唯一出处。
 * 单表无版本,写入路径都是单条语句,没有跨表一致性要求(对照 Agent 的两表 batch)。
 */

import type { NormalizedEnvironmentConfig } from '@nano/shared';
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';
import type { Db } from '../client';
import { environments } from '../schema';

export type EnvironmentRow = typeof environments.$inferSelect;

/** 环境的可变字段:service 合并(merge)完成后的完整形态,非补丁 */
export interface EnvironmentValues {
  name: string;
  description: string | null;
  config: NormalizedEnvironmentConfig;
  metadata: Record<string, string>;
}

/** 插入 Environment 行;config 已是归一化形态 */
export async function createEnvironment(
  db: Db,
  input: { id: string } & EnvironmentValues & { now: Date },
): Promise<void> {
  const { id, name, description, config, metadata, now } = input;
  await db.insert(environments).values({
    id,
    name,
    description,
    config,
    metadata,
    state: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

/** 按 id 取 Environment 行;查不到返回 null */
export async function findEnvironment(
  db: Db,
  environmentId: string,
): Promise<EnvironmentRow | null> {
  const rows = await db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return rows[0] ?? null;
}

/** environments 列表页游标:定位到 (created_at, id) 之后/之前的位置 */
export interface EnvironmentsPageCursor {
  createdAt: number;
  id: string;
}

/**
 * 按 (created_at, id) keyset 分页列出全部 Environment(含已归档)。
 * 多取一行判断是否还有下一页;同一毫秒内按 id 字典序保证全序稳定。
 */
export async function listEnvironmentsPage(
  db: Db,
  params: {
    limit: number;
    order: 'asc' | 'desc';
    cursor: EnvironmentsPageCursor | null;
  },
): Promise<{
  rows: EnvironmentRow[];
  nextCursor: EnvironmentsPageCursor | null;
}> {
  const conditions = [
    params.cursor
      ? (() => {
          const at = new Date(params.cursor!.createdAt);
          return params.order === 'desc'
            ? or(
                lt(environments.createdAt, at),
                and(eq(environments.createdAt, at), lt(environments.id, params.cursor!.id)),
              )
            : or(
                gt(environments.createdAt, at),
                and(eq(environments.createdAt, at), gt(environments.id, params.cursor!.id)),
              );
        })()
      : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(environments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      params.order === 'desc' ? desc(environments.createdAt) : asc(environments.createdAt),
      params.order === 'desc' ? desc(environments.id) : asc(environments.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt.getTime(), id: last.id } : null;
  return { rows: pageRows, nextCursor };
}

/**
 * 就地覆盖可变字段(WHERE state = 'active' 兜底已归档拒绝更新)。
 * 受影响 0 行有两种原因——行已不存在(404)与并发窗口内被归档(400),
 * 由 service 重读一次区分;返回 false 时调用方不得臆断原因。
 */
export async function updateEnvironment(
  db: Db,
  environmentId: string,
  values: EnvironmentValues,
  now: Date,
): Promise<boolean> {
  const result = (await db
    .update(environments)
    .set({
      name: values.name,
      description: values.description,
      config: values.config,
      metadata: values.metadata,
      updatedAt: now,
    })
    .where(
      and(eq(environments.id, environmentId), eq(environments.state, 'active')),
    )) as unknown as {
    meta?: { changes?: number };
  };
  return (result.meta?.changes ?? 0) > 0;
}

/** 幂等归档:仅当 active 时写入 archived 状态与归档时间,重复调用不改动任何数据 */
export async function archiveEnvironment(db: Db, environmentId: string, now: Date): Promise<void> {
  await db
    .update(environments)
    .set({ state: 'archived', archivedAt: now })
    .where(and(eq(environments.id, environmentId), eq(environments.state, 'active')));
}

/** 按 id 硬删除;不做引用计数(与 GLM 一致);受影响 0 行返回 false,由上层转成 404 */
export async function deleteEnvironment(db: Db, environmentId: string): Promise<boolean> {
  const result = (await db
    .delete(environments)
    .where(eq(environments.id, environmentId))) as unknown as {
    meta?: { changes?: number };
  };
  return (result.meta?.changes ?? 0) > 0;
}
