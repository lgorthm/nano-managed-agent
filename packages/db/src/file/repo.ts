/**
 * File 资源的仓储函数:元数据 SQL 的唯一出处。
 * 内容字节在 R2(对象键 files/{id}),由传输层 service 直接读写——R2 不是 SQL,
 * 不经过本层;「先 R2 后 D1 的写入顺序 / 先 D1 后 R2 的删除顺序」见 docs/files/schema.md。
 * 会话产出文件的编目映射在 session_outputs(归 session 模块的 repo),
 * 本层只消费它做 scope 过滤与回显。
 */
import { and, asc, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import type { Db } from '../client';
import { files, sessionOutputs, sessionResources } from '../schema';

export type FileRow = typeof files.$inferSelect;

/** files 行的插入形态;产出编目与上传共用 */
export interface FileInsertValues {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  etag: string;
  createdAt: Date;
}

/** 插入 File 元数据行;调用方需先完成 R2 put(对象键由 id 派生) */
export async function insertFile(db: Db, row: FileInsertValues): Promise<void> {
  await db.insert(files).values(row);
}

/** 按 id 取 File 元数据;查不到返回 null */
export async function findFile(db: Db, fileId: string): Promise<FileRow | null> {
  const rows = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  return rows[0] ?? null;
}

/** 按 id 取 File 元数据及产出归属(session_outputs 的 session_id;非产出为 null) */
export async function findFileWithScope(
  db: Db,
  fileId: string,
): Promise<{ file: FileRow; scopeSessionId: string | null } | null> {
  const rows = await db
    .select({ file: files, scopeSessionId: sessionOutputs.sessionId })
    .from(files)
    .leftJoin(sessionOutputs, eq(sessionOutputs.fileId, files.id))
    .where(eq(files.id, fileId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { file: row.file, scopeSessionId: row.scopeSessionId };
}

/** 批量取 File 元数据(会话挂载引用校验用);返回 id → 行,不含缺失项 */
export async function findFilesByIds(db: Db, fileIds: string[]): Promise<Map<string, FileRow>> {
  if (fileIds.length === 0) return new Map();
  const rows = await db.select().from(files).where(inArray(files.id, fileIds));
  return new Map(rows.map((row) => [row.id, row]));
}

/** files 列表页游标:定位到 (created_at, id) 之后/之前的位置 */
export interface FilesPageCursor {
  createdAt: number;
  id: string;
}

/** 列表行的产出归属;非产出文件为 null(挂载关系是多对多,不在列表回显) */
export interface FileListEntry {
  file: FileRow;
  scopeSessionId: string | null;
}

function filesKeysetCondition(
  cursor: FilesPageCursor | null,
  order: 'asc' | 'desc',
  columnCreatedAt: typeof files.createdAt,
  columnId: typeof files.id,
) {
  if (cursor === null) return undefined;
  const at = new Date(cursor.createdAt);
  return order === 'desc'
    ? or(lt(columnCreatedAt, at), and(eq(columnCreatedAt, at), lt(columnId, cursor.id)))
    : or(gt(columnCreatedAt, at), and(eq(columnCreatedAt, at), gt(columnId, cursor.id)));
}

/**
 * 按 (created_at, id) keyset 分页列出 File,并附带产出归属
 * (session_outputs 一对一,LEFT JOIN 不膨胀行数)。
 * 多取一行判断是否还有下一页;同一毫秒内按 id 字典序保证全序稳定。
 */
export async function listFilesPage(
  db: Db,
  params: {
    limit: number;
    order: 'asc' | 'desc';
    cursor: FilesPageCursor | null;
  },
): Promise<{ rows: FileListEntry[]; nextCursor: FilesPageCursor | null }> {
  const conditions = [
    filesKeysetCondition(params.cursor, params.order, files.createdAt, files.id),
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select({ file: files, scopeSessionId: sessionOutputs.sessionId })
    .from(files)
    .leftJoin(sessionOutputs, eq(sessionOutputs.fileId, files.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      params.order === 'desc' ? desc(files.createdAt) : asc(files.createdAt),
      params.order === 'desc' ? desc(files.id) : asc(files.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? { createdAt: last.file.createdAt.getTime(), id: last.file.id } : null;
  return { rows: pageRows, nextCursor };
}

/**
 * 按 id 删除元数据行(连带清理产出映射行,FK 顺序:先映射后本体);
 * 受影响 0 行(不存在)返回 false,由上层转成 404。
 */
export async function deleteFile(db: Db, fileId: string): Promise<boolean> {
  const results = await db.batch([
    db.delete(sessionOutputs).where(eq(sessionOutputs.fileId, fileId)),
    db.delete(files).where(eq(files.id, fileId)),
  ]);
  const deleteResult = results[1] as unknown as { meta?: { changes?: number } };
  return (deleteResult.meta?.changes ?? 0) > 0;
}

/**
 * scope_id 过滤:列出与指定会话相关的 File——被其挂载(session_resources)
 * ∪ 其产出(session_outputs)。以两个 IN 子查询的 OR 表达(单表 select,
 * 天然去重,免 UNION 列对齐),仍按 files 的 (created_at, id) keyset 分页,
 * 与全站列表共用游标形态。会话不存在或无关联时自然返回空页。
 */
export async function listFilesBySessionScopePage(
  db: Db,
  params: {
    sessionId: string;
    limit: number;
    order: 'asc' | 'desc';
    cursor: FilesPageCursor | null;
  },
): Promise<{ rows: FileListEntry[]; nextCursor: FilesPageCursor | null }> {
  const conditions = [
    or(
      inArray(
        files.id,
        db
          .select({ id: sessionResources.fileId })
          .from(sessionResources)
          .where(eq(sessionResources.sessionId, params.sessionId)),
      ),
      inArray(
        files.id,
        db
          .select({ id: sessionOutputs.fileId })
          .from(sessionOutputs)
          .where(eq(sessionOutputs.sessionId, params.sessionId)),
      ),
    ),
    filesKeysetCondition(params.cursor, params.order, files.createdAt, files.id),
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select({ file: files, scopeSessionId: sessionOutputs.sessionId })
    .from(files)
    .leftJoin(sessionOutputs, eq(sessionOutputs.fileId, files.id))
    .where(and(...conditions))
    .orderBy(
      params.order === 'desc' ? desc(files.createdAt) : asc(files.createdAt),
      params.order === 'desc' ? desc(files.id) : asc(files.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? { createdAt: last.file.createdAt.getTime(), id: last.file.id } : null;
  return { rows: pageRows, nextCursor };
}
