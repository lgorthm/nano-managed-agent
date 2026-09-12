/**
 * File 资源的响应类型与上传校验纯函数(设计见 docs/files/api/README.md)。
 * 上传走 multipart/form-data,没有 JSON 请求 schema。
 * GLM DTO 见 glm/file.ts;nano 的差异(无 scope、全站分页约定)记录在 API README 的差异表。
 */

/** 单文件上限 50 MiB;上传校验、413 文案与测试断言同源 */
export const MAX_FILE_BYTES = 52_428_800;

/** 文件名长度上限(字符数,UTF-8) */
export const MAX_FILENAME_LENGTH = 256;

/** 归一化后 mime_type 的长度上限 */
export const MAX_MIME_TYPE_LENGTH = 128;

/** scope_id 过滤参数的合法形态:sess_ 前缀(一期无 Session 资源,传入恒返回空页) */
export const SCOPE_ID_PATTERN = /^sess_/;

export interface FileResponse {
  id: string;
  type: "file";
  size_bytes: number;
  created_at: string;
  filename: string;
  mime_type: string;
  /** nano 恒为 true;保留字段以对齐 GLM wire-format */
  downloadable: boolean;
}

export interface FileDeletedResponse {
  id: string;
  type: "file_deleted";
}

/** R2 对象键:恒 files/{fileId},由 id 确定性派生、不落库(docs/files/schema.md 的约定) */
export function fileObjectKey(fileId: string): string {
  return `files/${fileId}`;
}

/** 校验上传文件名:1–256 个字符。返回错误消息,null 表示合法 */
export function validateFilename(filename: string): string | null {
  if (filename.length === 0) {
    return "filename must not be empty.";
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    return `filename exceeds ${MAX_FILENAME_LENGTH} characters.`;
  }
  return null;
}

/**
 * 归一化 part 的 Content-Type 为存储形态:
 * 取 essence(截掉 ";" 后的参数)并转小写;缺失、为空或不成 type/subtype
 * 形态时为 application/octet-stream;essence 超过 128 字符同样视为不可解析。
 */
export function normalizeMimeType(raw: string | null | undefined): string {
  const essence = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  if (essence.length === 0 || essence.length > MAX_MIME_TYPE_LENGTH) {
    return "application/octet-stream";
  }
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(essence)) {
    return "application/octet-stream";
  }
  return essence;
}
