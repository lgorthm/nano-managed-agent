import type { FileRow } from '@nano/db';
import type { FileResponse, FileScope } from '@nano/shared';

/**
 * File 行到 API JSON 的唯一序列化出口:
 * 时间戳转 ISO 8601 UTC,注入不落库的固定字段 type 与 downloadable(恒 true)。
 * scope 不落库:按 scope_id 过滤列出时由调用方传入回显,租户级列表不输出。
 */
export function serializeFile(row: FileRow, scope?: FileScope): FileResponse {
  return {
    id: row.id,
    type: 'file',
    size_bytes: row.sizeBytes,
    created_at: row.createdAt.toISOString(),
    filename: row.filename,
    mime_type: row.mimeType,
    downloadable: true,
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * 下载响应的 content-disposition:
 * ASCII 文件名直接放入引号段(引号与反斜杠替换为 _);非 ASCII 时先降级为
 * ASCII 安全回退名,再按 RFC 5987 追加 filename* 携带原始文件名。
 */
export function contentDisposition(filename: string): string {
  if (/^[\x20-\x7e]+$/.test(filename)) {
    return `attachment; filename="${filename.replace(/["\\]/g, '_')}"`;
  }
  const fallback = filename.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
