/**
 * Skill 资源的仓储函数:全部 Skill SQL 的唯一出处。
 * 事务边界收敛在这里——版本元数据、文件行与指针更新放进同一个 D1 batch(隐式事务)。
 *
 * 本文件同时承载跨资源的引用检查(读 agent_versions 表):db 层按表组织而非按模块组织,
 * 「Agent 引用 Skill」的两个切面(删除保护 / 存在性校验)都收在这里,
 * agent 与 skill 两个 service 各自调用,谁也不 import 谁。
 */

import type { CanonicalSkillTree, SkillReference } from '@nano/shared';
import { and, asc, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { agents, agentVersions, skillFiles, skills, skillVersions } from '../schema';

export type SkillRow = typeof skills.$inferSelect;
export type SkillVersionRow = typeof skillVersions.$inferSelect;
export type SkillFileRow = typeof skillFiles.$inferSelect;

/** 版本元数据:frontmatter 解析结果 + directory */
export interface SkillVersionMeta {
  name: string;
  description: string;
  directory: string;
}

/** 文件行的分块 multi-row INSERT 上限:避免单条语句过长、触碰绑定参数限制 */
const FILE_INSERT_CHUNK = 50;

function fileInsertStatements(db: Db, skillId: string, version: number, tree: CanonicalSkillTree) {
  const rows = tree.files.map((file) => ({
    skillId,
    version,
    path: file.path,
    content: file.bytes,
    size: file.size,
    sha256: file.sha256,
  }));
  const chunks: (typeof rows)[] = [];
  for (let i = 0; i < rows.length; i += FILE_INSERT_CHUNK) {
    chunks.push(rows.slice(i, i + FILE_INSERT_CHUNK));
  }
  return chunks.map((chunk) => db.insert(skillFiles).values(chunk));
}

function versionValues(
  skillId: string,
  version: number,
  versionId: string,
  meta: SkillVersionMeta,
  tree: CanonicalSkillTree,
  now: Date,
) {
  return {
    skillId,
    version,
    id: versionId,
    name: meta.name,
    description: meta.description,
    directory: meta.directory,
    fileCount: tree.fileCount,
    totalBytes: tree.totalBytes,
    contentSha256: tree.contentSha256,
    createdAt: now,
  };
}

/** 创建 Skill 及其首个版本;Skill 行、版本行与文件行在同一 batch 中原子执行 */
export async function createSkillWithFirstVersion(
  db: Db,
  input: {
    skillId: string;
    versionId: string;
    displayTitle: string | null;
    meta: SkillVersionMeta;
    tree: CanonicalSkillTree;
    now: Date;
  },
): Promise<void> {
  const { skillId, versionId, displayTitle, meta, tree, now } = input;
  await db.batch([
    db.insert(skills).values({
      id: skillId,
      displayTitle,
      source: 'custom',
      latestVersionSeq: 1,
      nextVersion: 2,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(skillVersions).values(versionValues(skillId, 1, versionId, meta, tree, now)),
    ...fileInsertStatements(db, skillId, 1, tree),
  ]);
}

/** 按 id 取 skills 行;查不到返回 null */
export async function findSkill(db: Db, skillId: string): Promise<SkillRow | null> {
  const rows = await db.select().from(skills).where(eq(skills.id, skillId)).limit(1);
  return rows[0] ?? null;
}

/** skills 列表页游标:定位到 (created_at, id) 之后/之前的位置 */
export interface SkillsPageCursor {
  createdAt: number;
  id: string;
}

/**
 * 按 (created_at, id) keyset 分页列出 Skill(含空壳)。
 * 多取一行判断是否还有下一页;同一毫秒内按 id 字典序保证全序稳定。
 */
export async function listSkillsPage(
  db: Db,
  params: {
    source?: 'custom' | 'zai';
    limit: number;
    order: 'asc' | 'desc';
    cursor: SkillsPageCursor | null;
  },
): Promise<{ rows: SkillRow[]; nextCursor: SkillsPageCursor | null }> {
  const conditions = [
    params.source === undefined ? undefined : eq(skills.source, params.source),
    params.cursor
      ? (() => {
          const at = new Date(params.cursor!.createdAt);
          return params.order === 'desc'
            ? or(
                lt(skills.createdAt, at),
                and(eq(skills.createdAt, at), lt(skills.id, params.cursor!.id)),
              )
            : or(
                gt(skills.createdAt, at),
                and(eq(skills.createdAt, at), gt(skills.id, params.cursor!.id)),
              );
        })()
      : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(skills)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      params.order === 'desc' ? desc(skills.createdAt) : asc(skills.createdAt),
      params.order === 'desc' ? desc(skills.id) : asc(skills.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last ? { createdAt: last.createdAt.getTime(), id: last.id } : null;
  return { rows: pageRows, nextCursor };
}

/**
 * 插入下一个 Skill 版本并前移指针,版本号分配的原子核心。
 *
 * 两阶段认领:D1 batch 只对 SQL 错误回滚,对「UPDATE 影响 0 行」照样提交,
 * 因此不能用「先插入、后 CAS」(抢号失败会留下孤儿文件行)。改为:
 * 1. 先以 WHERE next_version = expected 单独 CAS 认领版本号,0 行受影响立即返回 false,
 *    一个字节都不写;
 * 2. 认领成功后,在同一个 batch 里写入版本行与文件行并前移 latest_version_seq——
 *    批内任何 SQL 错误整体回滚,最坏结果是版本号留一个空洞(分配器只增不减,语义安全)。
 *
 * 命名加 Skill 前缀:与 agent/repo 的同名语义函数经由 @nano/db 汇总导出时避免冲突。
 */
export async function insertNextSkillVersionAndAdvance(
  db: Db,
  input: {
    skillId: string;
    expectedVersion: number;
    versionId: string;
    meta: SkillVersionMeta;
    tree: CanonicalSkillTree;
    now: Date;
  },
): Promise<boolean> {
  const { skillId, expectedVersion, versionId, meta, tree, now } = input;
  const claim = (await db
    .update(skills)
    .set({ nextVersion: expectedVersion + 1 })
    .where(and(eq(skills.id, skillId), eq(skills.nextVersion, expectedVersion)))) as unknown as {
    meta?: { changes?: number };
  };
  if ((claim.meta?.changes ?? 0) === 0) {
    return false;
  }
  await db.batch([
    db
      .insert(skillVersions)
      .values(versionValues(skillId, expectedVersion, versionId, meta, tree, now)),
    ...fileInsertStatements(db, skillId, expectedVersion, tree),
    db
      .update(skills)
      .set({ latestVersionSeq: expectedVersion, updatedAt: now })
      .where(eq(skills.id, skillId)),
  ]);
  return true;
}

/** 按 (skill_id, version) 取版本元数据行;查不到返回 null */
export async function findSkillVersion(
  db: Db,
  skillId: string,
  version: number,
): Promise<SkillVersionRow | null> {
  const rows = await db
    .select()
    .from(skillVersions)
    .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version)))
    .limit(1);
  return rows[0] ?? null;
}

/** 按 version keyset 分页列出指定 Skill 的全部版本(多取一行判断是否还有下一页) */
export async function listSkillVersionsPage(
  db: Db,
  skillId: string,
  params: { limit: number; order: 'asc' | 'desc'; cursor: number | null },
): Promise<{ rows: SkillVersionRow[]; nextCursor: number | null }> {
  const agentCondition = eq(skillVersions.skillId, skillId);
  const cursorCondition =
    params.cursor === null
      ? undefined
      : params.order === 'desc'
        ? lt(skillVersions.version, params.cursor)
        : gt(skillVersions.version, params.cursor);

  const rows = await db
    .select()
    .from(skillVersions)
    .where(cursorCondition === undefined ? agentCondition : and(agentCondition, cursorCondition))
    .orderBy(params.order === 'desc' ? desc(skillVersions.version) : asc(skillVersions.version))
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return { rows: pageRows, nextCursor: hasMore && last ? last.version : null };
}

/** 列出指定版本的全部文件行,按 path 有序(复合主键前缀扫描天然有序,ZIP 组装直接消费) */
export async function listSkillFiles(
  db: Db,
  skillId: string,
  version: number,
): Promise<SkillFileRow[]> {
  return db
    .select()
    .from(skillFiles)
    .where(and(eq(skillFiles.skillId, skillId), eq(skillFiles.version, version)))
    .orderBy(asc(skillFiles.path));
}

/**
 * 指定 Skill 版本是否被「活动配置」引用:未归档 Agent 的当前版本快照(json_extract 点查)。
 * 与 GLM「被活动配置引用」对齐——更新 Agent 解除引用、或归档 Agent 后即可删除;
 * 历史版本快照中的引用不阻止删除(它们只是不可变的配置记录,不再被新的会话使用)。
 */
export async function isSkillVersionReferenced(
  db: Db,
  skillId: string,
  version: number,
): Promise<boolean> {
  const row = await db.get<{ referenced: number }>(sql`
    SELECT EXISTS (
      SELECT 1
        FROM ${agentVersions} av
        JOIN ${agents} a ON a.id = av.agent_id AND a.current_version = av.version
                             AND a.archived_at IS NULL,
             json_each(av.skills) AS ref
       WHERE json_extract(ref.value, '$.skill_id') = ${skillId}
         AND json_extract(ref.value, '$.version') = ${String(version)}
    ) AS referenced
  `);
  return (row?.referenced ?? 0) === 1;
}

/** 指定 Skill 的任意版本是否被「活动配置」引用(整技能删除保护) */
export async function isSkillReferenced(db: Db, skillId: string): Promise<boolean> {
  const row = await db.get<{ referenced: number }>(sql`
    SELECT EXISTS (
      SELECT 1
        FROM ${agentVersions} av
        JOIN ${agents} a ON a.id = av.agent_id AND a.current_version = av.version
                             AND a.archived_at IS NULL,
             json_each(av.skills) AS ref
       WHERE json_extract(ref.value, '$.skill_id') = ${skillId}
    ) AS referenced
  `);
  return (row?.referenced ?? 0) === 1;
}

/**
 * Agent 侧存在性校验的支撑:对引用列表去重后逐个点查 (skill_id, version),
 * 返回无法解析的引用键集合("type|skill_id|version")。
 * 引用的 version 必须能解析为 ≥ 1 的整数,否则视为不可解析。
 */
export async function findMissingSkillVersionPairs(
  db: Db,
  references: readonly SkillReference[],
): Promise<Set<string>> {
  const missing = new Set<string>();
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.type}|${reference.skill_id}|${reference.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const version = Number(reference.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      missing.add(key);
      continue;
    }
    const row = await db.get<{ one: number }>(sql`
      SELECT 1 AS one FROM ${skillVersions}
       WHERE skill_id = ${reference.skill_id} AND version = ${version} LIMIT 1
    `);
    if (!row) missing.add(key);
  }
  return missing;
}

/**
 * 删除指定版本并在同一 batch 内重指 latest_version_seq:
 * 1. 删文件行;2. 删版本行(不存在时受影响行为零 → 返回 false);
 * 3. 按 MAX(version) 子查询重指指针——batch 内语句顺序执行,子查询已看不到被删的版本行,
 *    没有剩余版本时置 NULL(空壳 Skill)。
 * 指针重指与删除拆开会出现「版本已删、指针悬空」的窗口,必须同 batch。
 */
export async function deleteSkillVersionAndRetarget(
  db: Db,
  input: { skillId: string; version: number; now: Date },
): Promise<boolean> {
  const { skillId, version, now } = input;
  const results = await db.batch([
    db
      .delete(skillFiles)
      .where(and(eq(skillFiles.skillId, skillId), eq(skillFiles.version, version))),
    db
      .delete(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.version, version))),
    db
      .update(skills)
      .set({
        latestVersionSeq: sql`(SELECT MAX(version) FROM ${skillVersions} WHERE ${skillVersions.skillId} = ${skillId})`,
        updatedAt: now,
      })
      .where(eq(skills.id, skillId)),
  ]);
  const versionDelete = results[1] as unknown as {
    meta?: { changes?: number };
  };
  return (versionDelete.meta?.changes ?? 0) > 0;
}

/** 级联删除 Skill:文件行、版本行、Skill 行在同一 batch 中删除 */
export async function deleteSkillCascade(db: Db, skillId: string): Promise<void> {
  await db.batch([
    db.delete(skillFiles).where(eq(skillFiles.skillId, skillId)),
    db.delete(skillVersions).where(eq(skillVersions.skillId, skillId)),
    db.delete(skills).where(eq(skills.id, skillId)),
  ]);
}
