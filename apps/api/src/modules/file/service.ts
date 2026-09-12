/**
 * File 资源的业务编排层。
 * 元数据在 D1(repo),内容在 R2(对象键 files/{id});一致性由顺序保证
 * (docs/files/schema.md):上传先 R2 后 D1(插入失败补偿删对象),
 * 删除先 D1 后 R2(尽力清理,孤儿对象不破坏正确性)。
 */
import {
  deleteFile as deleteFileRow,
  findFile,
  getDb,
  insertFile,
  listFilesPage,
  newFileId,
} from "@nano/db";
import {
  MAX_FILE_BYTES,
  fileObjectKey,
  normalizeMimeType,
  validateFilename,
  type FileDeletedResponse,
  type FileResponse,
  type Page,
} from "@nano/shared";
import type { Env } from "../../env";
import {
  ApiError,
  invalidRequestError,
  notFoundError,
  requestTooLargeError,
} from "../../lib/errors";
import {
  cursorNumberField,
  cursorStringField,
  encodeCursor,
  type ListParams,
} from "../../lib/pagination";
import { serializeFile } from "./serialize";

/** files 列表游标的 kind 前缀,防止与其他列表端点的游标混用 */
const FILES_CURSOR_KIND = "files";

export const fileService = {
  /**
   * 上传:校验 → R2 put(记录 ETag)→ D1 insert。
   * 成功后「元数据在 ⇒ 内容可读」成立;D1 插入失败时补偿删除刚写入的对象。
   */
  async uploadFile(env: Env, file: File): Promise<FileResponse> {
    const filenameError = validateFilename(file.name);
    if (filenameError !== null) {
      throw invalidRequestError(filenameError, { param: "file" });
    }
    if (file.size === 0) {
      throw invalidRequestError("Uploaded file must not be empty.", { param: "file" });
    }
    if (file.size > MAX_FILE_BYTES) {
      throw requestTooLargeError(`File exceeds the ${MAX_FILE_BYTES} byte limit.`, {
        param: "file",
      });
    }
    const mimeType = normalizeMimeType(file.type);
    const id = newFileId();
    const key = fileObjectKey(id);
    const now = new Date();
    const object = await env.FILES.put(key, file, {
      httpMetadata: { contentType: mimeType },
    });
    try {
      await insertFile(getDb(env), {
        id,
        filename: file.name,
        mimeType,
        sizeBytes: file.size,
        etag: object.httpEtag,
        createdAt: now,
      });
    } catch (err) {
      console.error("file metadata insert failed:", err);
      await env.FILES.delete(key).catch(() => {});
      throw new ApiError("api_error", "Failed to persist the uploaded file.");
    }
    return serializeFile({
      id,
      filename: file.name,
      mimeType,
      sizeBytes: file.size,
      etag: object.httpEtag,
      createdAt: now,
    });
  },

  /** 获取元数据;不存在时抛 404 */
  async getFile(env: Env, fileId: string): Promise<FileResponse> {
    const row = await findFile(getDb(env), fileId);
    if (!row) {
      throw notFoundError(`File "${fileId}" not found.`);
    }
    return serializeFile(row);
  },

  /**
   * 分页列出 File,按 (created_at, id) keyset。
   * scope_id 一期无 Session 资源,校验前缀后恒返回空页(对 GLM 客户端保持 wire 兼容)。
   */
  async listFiles(
    env: Env,
    params: ListParams & { scopeId?: string },
  ): Promise<Page<FileResponse>> {
    if (params.scopeId !== undefined) {
      return { data: [], next_page: null };
    }
    const cursor =
      params.cursor === null
        ? null
        : {
            createdAt: cursorNumberField(params.cursor, "createdAt"),
            id: cursorStringField(params.cursor, "id"),
          };
    const { rows, nextCursor } = await listFilesPage(getDb(env), {
      limit: params.limit,
      order: params.order,
      cursor,
    });
    return {
      data: rows.map(serializeFile),
      next_page: nextCursor
        ? encodeCursor({
            kind: FILES_CURSOR_KIND,
            createdAt: nextCursor.createdAt,
            id: nextCursor.id,
          })
        : null,
    };
  },

  /**
   * 下载:元数据点查 → R2 get → 流式透传。
   * 元数据在而对象缺违反不变式,属运维事故路径,返回 api_error。
   */
  async downloadFileContent(
    env: Env,
    fileId: string,
  ): Promise<{ body: ReadableStream; filename: string; mimeType: string; etag: string }> {
    const row = await findFile(getDb(env), fileId);
    if (!row) {
      throw notFoundError(`File "${fileId}" not found.`);
    }
    const object = await env.FILES.get(fileObjectKey(fileId));
    if (!object) {
      console.error(`file content missing for metadata row: ${fileId}`);
      throw new ApiError("api_error", "File content is unavailable.");
    }
    return { body: object.body, filename: row.filename, mimeType: row.mimeType, etag: row.etag };
  },

  /** 删除:先删元数据(0 行受影响 → 404),再尽力清理 R2 对象 */
  async deleteFile(env: Env, fileId: string): Promise<FileDeletedResponse> {
    const deleted = await deleteFileRow(getDb(env), fileId);
    if (!deleted) {
      throw notFoundError(`File "${fileId}" not found.`);
    }
    try {
      await env.FILES.delete(fileObjectKey(fileId));
    } catch (err) {
      // 元数据已删,孤儿对象不影响正确性(下载先查元数据);清理留作运维脚本
      console.error(`orphan R2 object after delete: ${fileObjectKey(fileId)}`, err);
    }
    return { id: fileId, type: "file_deleted" };
  },
};
