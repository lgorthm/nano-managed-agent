import type {
  FileDeleted,
  FileListQuery,
  ManagedFile,
  ManagedFilePage,
} from "@nano/shared/glm";
import { filenameFromDisposition, glmFetch, glmFetchRaw, qs } from "./client";

const BASE = "/agent/managed/v1/files";

export function listFiles(query: FileListQuery = {}) {
  return glmFetch<ManagedFilePage>(`${BASE}${qs(query)}`);
}

export function getFile(fileId: string) {
  return glmFetch<ManagedFile>(`${BASE}/${fileId}`);
}

/** multipart 上传单个文件;只要求 file 字段,filename 等元数据由服务端保存 */
export function uploadFile(file: globalThis.File) {
  const form = new FormData();
  form.set("file", file);
  return glmFetch<ManagedFile>(BASE, { method: "POST", body: form });
}

/** 下载原始内容;GLM 可能不带 content-disposition,用元数据里的 filename 兜底 */
export async function downloadFile(file: ManagedFile) {
  const res = await glmFetchRaw(`${BASE}/${file.id}/content`);
  return {
    blob: await res.blob(),
    filename: filenameFromDisposition(res.headers.get("content-disposition")) ?? file.filename,
  };
}

/** 被会话引用等不满足删除条件时服务端拒绝,错误信息里会给出原因 */
export function deleteFile(fileId: string) {
  return glmFetch<FileDeleted>(`${BASE}/${fileId}`, { method: "DELETE" });
}
