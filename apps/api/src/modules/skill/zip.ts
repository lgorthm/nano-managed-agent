import { zipSync } from "fflate";

/**
 * 规范树 → ZIP 字节流(docs/skills/api/download-skill-zip.md)。
 * 确定性要求:根目录一层 <directory>/、条目按 path 字典序(上游 listSkillFiles 已有序)、
 * mtime 恒为版本 created_at——同一版本的任意两次下载字节一致,ETag 因此稳定。
 * 空的中间目录不产生条目(ZIP 只存文件)。
 */
export function buildSkillZip(
  directory: string,
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  mtime: Date,
): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[`${directory}/${file.path}`] = file.bytes;
  }
  return zipSync(entries, { mtime, level: 6 });
}
