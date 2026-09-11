import { parseSkillFrontmatter } from "@nano/shared";

/** 与 GLM 服务端一致的上传上限(见 references/api/create-skill.md) */
export const SKILL_UPLOAD_LIMITS = {
  maxFiles: 256,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
} as const;

export interface PickedSkillFile {
  path: string;
  file: File;
}

export interface CollectedSkillFiles {
  files: PickedSkillFile[];
  /** SKILL.md frontmatter 解析结果,上传前预览用 */
  frontmatter: { name: string; description: string } | null;
  totalBytes: number;
}

type CollectResult = { ok: true; data: CollectedSkillFiles } | { ok: false; error: string };

/**
 * 把目录选择器选中的文件整理成可上传形态。
 * GLM 要求全部文件位于同一个顶层目录下且该目录里有 SKILL.md(实测行为,与 nano 的
 * 「单根剥离」不同:前缀必须保留,它就是版本的 directory),这里在上传前做同样校验,
 * 并丢弃服务端会拒绝的 `.git` 段。
 */
export async function collectSkillFiles(fileList: Iterable<File>): Promise<CollectResult> {
  const entries: PickedSkillFile[] = [];
  for (const file of fileList) {
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
    if (path.split("/").some((segment) => segment === ".git")) continue;
    entries.push({ path, file });
  }
  if (entries.length === 0) return { ok: false, error: "未选择任何文件" };

  const roots = new Set(entries.map((entry) => entry.path.split("/")[0]));
  const root = roots.size === 1 ? [...roots][0] : undefined;
  const skillMd = root === undefined ? undefined : entries.find((entry) => entry.path === `${root}/SKILL.md`);
  if (!skillMd) {
    return { ok: false, error: "所选文件必须在同一个顶层目录下,且该目录里有 SKILL.md(请选择整个 Skill 目录)" };
  }

  if (entries.length > SKILL_UPLOAD_LIMITS.maxFiles) {
    return { ok: false, error: `文件数超过上限(${SKILL_UPLOAD_LIMITS.maxFiles} 个)` };
  }

  const totalBytes = entries.reduce((sum, entry) => sum + entry.file.size, 0);
  if (totalBytes > SKILL_UPLOAD_LIMITS.maxTotalBytes) {
    return { ok: false, error: "目录总大小超过 20 MiB 上限" };
  }

  const frontmatter = parseSkillFrontmatter(new Uint8Array(await skillMd.file.arrayBuffer()));
  if (!frontmatter.ok) return { ok: false, error: `SKILL.md: ${frontmatter.error.message}` };

  return { ok: true, data: { files: entries, frontmatter: frontmatter.data, totalBytes } };
}
