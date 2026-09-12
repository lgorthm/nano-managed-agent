/**
 * File 资源的仓储函数:元数据 SQL 的唯一出处。
 * 内容字节在 R2(对象键 files/{id}),由传输层 service 直接读写——R2 不是 SQL,
 * 不经过本层;「先 R2 后 D1 的写入顺序 / 先 D1 后 R2 的删除顺序」见 docs/files/schema.md。
 */
import { and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { Db } from "../client";
import { files, sessionResources } from "../schema";

export type FileRow = typeof files.$inferSelect;

/** 插入 File 元数据行;调用方需先完成 R2 put(对象键由 id 派生) */
export async function insertFile(
  db: Db,
  row: { id: string; filename: string; mimeType: string; sizeBytes: number; etag: string; createdAt: Date },
): Promise<void> {
  await db.insert(files).values(row);
}

/** 按 id 取 File 元数据;查不到返回 null */
export async function findFile(db: Db, fileId: string): Promise<FileRow | null> {
  const rows = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
  return rows[0] ?? null;
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

/**
 * 按 (created_at, id) keyset 分页列出 File。
 * 多取一行判断是否还有下一页;同一毫秒内按 id 字典序保证全序稳定。
 */
export async function listFilesPage(
  db: Db,
  params: { limit: number; order: "asc" | "desc"; cursor: FilesPageCursor | null },
): Promise<{ rows: FileRow[]; nextCursor: FilesPageCursor | null }> {
  const conditions = [
    params.cursor
      ? (() => {
          const at = new Date(params.cursor!.createdAt);
          return params.order === "desc"
            ? or(lt(files.createdAt, at), and(eq(files.createdAt, at), lt(files.id, params.cursor!.id)))
            : or(gt(files.createdAt, at), and(eq(files.createdAt, at), gt(files.id, params.cursor!.id)));
        })()
      : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select()
    .from(files)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      params.order === "desc" ? desc(files.createdAt) : asc(files.createdAt),
      params.order === "desc" ? desc(files.id) : asc(files.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? { createdAt: last.createdAt.getTime(), id: last.id } : null;
  return { rows: pageRows, nextCursor };
}

/** 按 id 删除元数据行;受影响 0 行(不存在)返回 false,由上层转成 404 */
export async function deleteFile(db: Db, fileId: string): Promise<boolean> {
  const result = (await db.delete(files).where(eq(files.id, fileId))) as unknown as {
    meta?: { changes?: number };
  };
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * scope_id 过滤:列出被指定会话挂载的 File(join session_resources),
 * 仍按 files 的 (created_at, id) keyset 分页,与全站列表共用游标形态。
 * 会话不存在或无挂载时自然返回空页。
 */
export async function listFilesBySessionMountPage(
  db: Db,
  params: { sessionId: string; limit: number; order: "asc" | "desc"; cursor: FilesPageCursor | null },
): Promise<{ rows: FileRow[]; nextCursor: FilesPageCursor | null }> {
  const conditions = [
    eq(sessionResources.sessionId, params.sessionId),
    params.cursor
      ? (() => {
          const at = new Date(params.cursor!.createdAt);
          return params.order === "desc"
            ? or(lt(files.createdAt, at), and(eq(files.createdAt, at), lt(files.id, params.cursor!.id)))
            : or(gt(files.createdAt, at), and(eq(files.createdAt, at), gt(files.id, params.cursor!.id)));
        })()
      : undefined,
  ].filter((condition) => condition !== undefined);

  const rows = await db
    .select({ file: files })
    .from(files)
    .innerJoin(sessionResources, eq(sessionResources.fileId, files.id))
    .where(and(...conditions))
    // 同一 file 被同一会话挂多个路径时 join 会出多行,按主键分组去重
    // (SQLite 允许非聚合列,组内 join 重复行的 file 部分完全一致)
    .groupBy(files.id)
    .orderBy(
      params.order === "desc" ? desc(files.createdAt) : asc(files.createdAt),
      params.order === "desc" ? desc(files.id) : asc(files.id),
    )
    .limit(params.limit + 1);

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last ? { createdAt: last.file.createdAt.getTime(), id: last.file.id } : null;
  return { rows: pageRows.map((row) => row.file), nextCursor };
}
