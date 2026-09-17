/**
 * File 资源的业务编排层。
 * 元数据在 D1(repo),内容在 R2(对象键 files/{id});一致性由顺序保证
 * (docs/files/schema.md):上传先 R2 后 D1(插入失败补偿删对象),
 * 删除先 D1 后 R2(尽力清理,孤儿对象不破坏正确性)。
 */
import {
  countActiveSessionMounts,
  countActiveSessionOutputs,
  deleteFile as deleteFileRow,
  findFile,
  findFileWithScope,
  getDb,
  insertFile,
  listFilesBySessionScopePage,
  listFilesPage,
  newFileId,
} from '@nano/db';
import {
  type FileDeletedResponse,
  type FileResponse,
  type FileScope,
  fileObjectKey,
  MAX_FILE_BYTES,
  normalizeMimeType,
  type Page,
  validateFilename,
} from '@nano/shared';
import type { Env } from '../../env';
import {
  ApiError,
  invalidRequestError,
  notFoundError,
  requestTooLargeError,
} from '../../lib/errors';
import {
  cursorNumberField,
  cursorStringField,
  encodeCursor,
  type ListParams,
} from '../../lib/pagination';
import { serializeFile } from './serialize';

/** files 列表游标的 kind 前缀,防止与其他列表端点的游标混用 */
const FILES_CURSOR_KIND = 'files';

export const fileService = {
  /**
   * 上传:校验 → R2 put(记录 ETag)→ D1 insert。
   * 成功后「元数据在 ⇒ 内容可读」成立;D1 插入失败时补偿删除刚写入的对象。
   */
  async uploadFile(env: Env, file: File): Promise<FileResponse> {
    const filenameError = validateFilename(file.name);
    if (filenameError !== null) {
      throw invalidRequestError(filenameError, { param: 'file' });
    }
    if (file.size === 0) {
      throw invalidRequestError('Uploaded file must not be empty.', {
        param: 'file',
      });
    }
    if (file.size > MAX_FILE_BYTES) {
      throw requestTooLargeError(`File exceeds the ${MAX_FILE_BYTES} byte limit.`, {
        param: 'file',
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
      console.error('file metadata insert failed:', err);
      await env.FILES.delete(key).catch(() => {});
      throw new ApiError('api_error', 'Failed to persist the uploaded file.');
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

  /** 获取元数据;不存在时抛 404。产出文件恒回显 scope(一对一归属) */
  async getFile(env: Env, fileId: string): Promise<FileResponse> {
    const found = await findFileWithScope(getDb(env), fileId);
    if (!found) {
      throw notFoundError(`File "${fileId}" not found.`);
    }
    return serializeFile(
      found.file,
      found.scopeSessionId !== null ? { type: 'session', id: found.scopeSessionId } : undefined,
    );
  },

  /**
   * 分页列出 File,按 (created_at, id) keyset。
   * scope_id 过滤:列出与该会话相关的 File(挂载 ∪ 产出);会话不存在或
   * 无关联时自然返回空页。
   * scope 回显:产出文件在任何列表都带自己的归属 scope(一对一,恒可回显);
   * 挂载的 File 是多对多,只在 scope_id 过滤时回显该会话,租户级列表不输出。
   */
  async listFiles(
    env: Env,
    params: ListParams & { scopeId?: string },
  ): Promise<Page<FileResponse>> {
    const cursor =
      params.cursor === null
        ? null
        : {
            createdAt: cursorNumberField(params.cursor, 'createdAt'),
            id: cursorStringField(params.cursor, 'id'),
          };
    const { rows, nextCursor } =
      params.scopeId === undefined
        ? await listFilesPage(getDb(env), {
            limit: params.limit,
            order: params.order,
            cursor,
          })
        : await listFilesBySessionScopePage(getDb(env), {
            sessionId: params.scopeId,
            limit: params.limit,
            order: params.order,
            cursor,
          });
    const mountScope: FileScope | undefined =
      params.scopeId === undefined ? undefined : { type: 'session', id: params.scopeId };
    return {
      data: rows.map((entry) =>
        serializeFile(
          entry.file,
          entry.scopeSessionId !== null
            ? { type: 'session', id: entry.scopeSessionId }
            : mountScope,
        ),
      ),
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
  ): Promise<{
    body: ReadableStream;
    filename: string;
    mimeType: string;
    etag: string;
  }> {
    const row = await findFile(getDb(env), fileId);
    if (!row) {
      throw notFoundError(`File "${fileId}" not found.`);
    }
    const object = await env.FILES.get(fileObjectKey(fileId));
    if (!object) {
      console.error(`file content missing for metadata row: ${fileId}`);
      throw new ApiError('api_error', 'File content is unavailable.');
    }
    return {
      body: object.body,
      filename: row.filename,
      mimeType: row.mimeType,
      etag: row.etag,
    };
  },

  /**
   * 删除:引用检查(被未归档会话挂载,或是未归档会话的产出 → 拒绝删除)
   * → 删元数据与产出映射行(0 行受影响 → 404)→ 尽力清理 R2 对象。
   * 已归档会话的挂载与产出都不阻止删除(docs/files/schema.md 的联动条款)。
   */
  async deleteFile(env: Env, fileId: string): Promise<FileDeletedResponse> {
    const mounts = await countActiveSessionMounts(getDb(env), fileId);
    if (mounts > 0) {
      throw invalidRequestError(
        `File is mounted by ${mounts} active session(s) and cannot be deleted.`,
        { param: 'fileId', mounts },
      );
    }
    const outputs = await countActiveSessionOutputs(getDb(env), fileId);
    if (outputs > 0) {
      throw invalidRequestError(
        `File is an output of ${outputs} active session(s) and cannot be deleted.`,
        { param: 'fileId', outputs },
      );
    }
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
    return { id: fileId, type: 'file_deleted' };
  },
};
