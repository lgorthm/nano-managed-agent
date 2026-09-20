/**
 * 会话产出文件的收割编目(docs/files/schema.md「与 Session 的联动」)。
 * 从 ToolRunner 抽出来的编排函数:输入是沙箱 outputs 目录的「相对路径 → 字节」
 * 快照,输出是 D1/R2 的编目收敛——vitest 无需真实沙箱即可覆盖全部语义,
 * SandboxToolRunner 只负责把沙箱文件读成快照。
 *
 * 收敛规则(差集同步,以沙箱现状为准):
 * - 新路径 → R2 put files/{newId} → 同 batch 插 file 行 + 映射行(created)
 * - 内容变化(sha-256 不同)→ R2 put 新对象 → 同 batch 插新 file 行 + 映射改指 +
 *   删旧 file 行(replaced;File 不可变,「更新」落地为换 id),旧 R2 对象尽力清
 * - 内容未变 → 跳过(幂等:同文件重复收割零写入)
 * - 映射有、沙箱无 → 连映射行带 file 行删除,R2 对象尽力清(差集)
 * 一致性沿用上传的顺序契约:先 R2 后 D1,D1 失败补偿删新对象;
 * 反向(先 D1 后 R2)的删除失败只留孤儿对象,不影响正确性。
 */
import {
  createSessionOutput,
  deleteSessionOutput,
  findSessionOutputsBySession,
  getDb,
  newFileId,
  replaceSessionOutput,
} from '@nano/db';
import { fileObjectKey, MAX_FILE_BYTES, MAX_FILENAME_LENGTH, mimeTypeFromPath } from '@nano/shared';
import { log } from '@nano/shared/log';
import type { Env } from '../../env';

/** 沙箱 outputs 目录的一个文件;path 是 /mnt/session/outputs 下的相对路径 */
export interface HarvestedOutput {
  path: string;
  bytes: Uint8Array;
}

export interface HarvestResult {
  created: number;
  replaced: number;
  removed: number;
  skippedUnchanged: number;
}

/** 产出相对路径的合法性:非空、不以 / 开头、不含 .. 段(防回填越界) */
function validRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/')) return false;
  return !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 把沙箱快照收敛成编目。逐文件独立收敛(一个文件的失败不拖累其余),
 * 抛出的错误由调用方(harvestOutputs)记日志——本轮收敛中断,下一 turn
 * 重新收割时按同一规则收敛,无中间态破坏「行存在 ⇔ 内容可读」。
 */
export async function harvestSessionOutputs(
  env: Env,
  sessionId: string,
  sandboxFiles: HarvestedOutput[],
): Promise<HarvestResult> {
  const db = getDb(env);
  const result: HarvestResult = {
    created: 0,
    replaced: 0,
    removed: 0,
    skippedUnchanged: 0,
  };
  const existing = new Map(
    (await findSessionOutputsBySession(db, sessionId)).map((row) => [row.path, row]),
  );

  for (const file of sandboxFiles) {
    // 先取后删:previous 供对比,同时把该 path 移出差集基准——
    // 出现在快照里的 path 一律不算「消失」,包括被跳过编目的
    // (超限/非法路径/内容未变)
    const previous = existing.get(file.path);
    existing.delete(file.path);
    if (!validRelativePath(file.path)) {
      log.warn('session output path rejected (not a safe relative path)', {
        sessionId,
        path: file.path,
      });
      continue;
    }
    if (file.bytes.byteLength > MAX_FILE_BYTES) {
      // 超限产出不编目:沙箱内仍可用,只是不进 File 资源(与上传上限同口径);
      // warn 而非 error:这是模型产出的预期输入域问题,不是系统故障
      log.warn('session output exceeds limit, skipping catalog', {
        sessionId,
        path: file.path,
        limitBytes: MAX_FILE_BYTES,
      });
      continue;
    }
    if (file.path.length > MAX_FILENAME_LENGTH) {
      log.warn('session output filename exceeds limit, skipping catalog', {
        sessionId,
        path: file.path,
        limitChars: MAX_FILENAME_LENGTH,
      });
      continue;
    }
    const contentSha256 = await sha256Hex(file.bytes);
    if (previous !== undefined && previous.contentSha256 === contentSha256) {
      result.skippedUnchanged += 1;
      continue;
    }

    const id = newFileId();
    const mimeType = mimeTypeFromPath(file.path);
    const key = fileObjectKey(id);
    const now = new Date();
    const object = await env.FILES.put(key, file.bytes, {
      httpMetadata: { contentType: mimeType },
    });
    const row = {
      id,
      filename: file.path,
      mimeType,
      sizeBytes: file.bytes.byteLength,
      etag: object.httpEtag,
      createdAt: now,
    };
    let replacedOldFileId: string | null = null;
    try {
      if (previous === undefined) {
        await createSessionOutput(db, {
          file: row,
          sessionId,
          path: file.path,
          contentSha256,
          now,
        });
        result.created += 1;
      } else {
        replacedOldFileId = await replaceSessionOutput(db, {
          file: row,
          sessionId,
          path: file.path,
          contentSha256,
          now,
        });
        result.replaced += 1;
      }
    } catch (err) {
      // 「先 R2 后 D1」的补偿:插入失败时删掉刚写入的对象,维持行存在 ⇔ 内容可读
      await env.FILES.delete(key).catch(() => {});
      throw err;
    }
    if (replacedOldFileId !== null) {
      await env.FILES.delete(fileObjectKey(replacedOldFileId)).catch(() => {});
    }
  }

  // 差集:编目过但沙箱里已消失的产出(物化协议保证编目内容必已回填,
  // 故 find 快照完整时差集即真实删除;find 失败时调用方根本不会进本函数)
  for (const path of existing.keys()) {
    const removedFileId = await deleteSessionOutput(db, { sessionId, path });
    if (removedFileId !== null) {
      result.removed += 1;
      await env.FILES.delete(fileObjectKey(removedFileId)).catch(() => {});
    }
  }
  return result;
}
