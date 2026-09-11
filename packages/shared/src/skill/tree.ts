/**
 * Skill 规范树(docs/skills/schema.md 的「规范树」一节):
 * 把上传的原始「字段名 → 字节」映射归一化为唯一形态——校验路径、剥离单根前缀、
 * 确认 SKILL.md 在根、裁决上限、计算逐文件与整树哈希。纯函数,不含任何 IO。
 */
/** 目录内文件数上限(含 SKILL.md);超出属请求形态错误(400) */
export const MAX_FILES = 256;
/** 单文件字节数上限;超出属请求体过大(413) */
export const MAX_FILE_BYTES = 1024 * 1024;
/** 上传总量上限;超出属请求体过大(413) */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** 路径总长上限(字符) */
export const MAX_PATH_LENGTH = 256;
/** 路径段数上限(/ 分隔) */
export const MAX_PATH_SEGMENTS = 16;
/** 单个路径段长度上限(字符) */
export const MAX_SEGMENT_LENGTH = 128;

/** 上传的原始文件:multipart 字段名即 Skill 内相对路径 */
export interface RawSkillFile {
  path: string;
  bytes: Uint8Array;
}

/** 规范树错误码;file_too_large / total_too_large 对应 413,其余对应 400 */
export type SkillTreeErrorCode =
  | "too_many_files"
  | "invalid_path"
  | "duplicate_path"
  | "multi_root"
  | "missing_skill_md"
  | "file_too_large"
  | "total_too_large";

export interface SkillTreeError {
  code: SkillTreeErrorCode;
  message: string;
  param?: string;
}

/** 归一化后的单个文件:路径已剥离单根前缀,携带字节数与 SHA-256 */
export interface CanonicalSkillFile {
  path: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
}

/** 归一化后的目录树:files 按 path 字典序排列 */
export interface CanonicalSkillTree {
  files: CanonicalSkillFile[];
  /** 被剥离的单根前缀名;无前缀时为 null(此时 directory 取 frontmatter name) */
  strippedRoot: string | null;
  fileCount: number;
  totalBytes: number;
  /** 规范树哈希:对排序后的 (path, sha256) 行逐行拼接后取 SHA-256,用于下载 ETag */
  contentSha256: string;
  /** 根级 SKILL.md 条目(frontmatter 从它解析) */
  skillMd: CanonicalSkillFile;
}

export type NormalizeSkillTreeResult =
  | { ok: true; tree: CanonicalSkillTree }
  | { ok: false; error: SkillTreeError };

/** 单条路径的合法性;返回 null 表示合法,否则返回问题描述 */
export function skillPathIssue(path: string): string | null {
  if (path.length === 0) return "path is empty";
  if (path.length > MAX_PATH_LENGTH) return `path exceeds ${MAX_PATH_LENGTH} characters`;
  if (path.startsWith("/")) return "path must be relative, not absolute";
  if (path.includes("\\")) return "path must use / as the separator";
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return "path contains control characters";
  }
  if (path === ".git" || path.startsWith(".git/")) return "path must not live under .git";
  const segments = path.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) return `path exceeds ${MAX_PATH_SEGMENTS} segments`;
  for (const segment of segments) {
    if (segment.length === 0) return "path contains an empty segment";
    if (segment === "." || segment === "..") return "path must not contain . or .. segments";
    if (segment.length > MAX_SEGMENT_LENGTH) return `path segment exceeds ${MAX_SEGMENT_LENGTH} characters`;
  }
  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // DOM lib 的 BufferSource 只收 ArrayBuffer 背书的视图(workers-types 无此限制,
  // 该文件被 console 间接引用时按 DOM lib 检查);bytes 恒来自 arrayBuffer()/TextEncoder,不会是 SharedArrayBuffer。
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function error(code: SkillTreeErrorCode, message: string, param?: string): NormalizeSkillTreeResult {
  return { ok: false, error: { code, message, param } };
}

/**
 * 归一化上传目录。判定顺序:
 * 文件数 → 逐路径校验 + 重复检测 + 尺寸裁决 → 单根剥离 → SKILL.md 在根 → 哈希。
 * 单根剥离只在「SKILL.md 不在顶层,且所有路径共享同一前缀、SKILL.md 位于该前缀下」时发生;
 * 前缀下没有 SKILL.md 报 missing_skill_md,多个顶层目录报 multi_root。
 */
export async function normalizeSkillTree(files: RawSkillFile[]): Promise<NormalizeSkillTreeResult> {
  if (files.length === 0) {
    return error("missing_skill_md", "Upload must contain SKILL.md at the top level.", "SKILL.md");
  }
  if (files.length > MAX_FILES) {
    return error(
      "too_many_files",
      `Upload contains ${files.length} files; at most ${MAX_FILES} are allowed.`,
    );
  }

  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    const issue = skillPathIssue(file.path);
    if (issue !== null) {
      return error("invalid_path", `Invalid path "${file.path}": ${issue}.`, file.path);
    }
    if (seen.has(file.path)) {
      return error("duplicate_path", `Duplicate path "${file.path}".`, file.path);
    }
    seen.add(file.path);
    if (file.bytes.length > MAX_FILE_BYTES) {
      return error(
        "file_too_large",
        `File "${file.path}" is ${file.bytes.length} bytes; at most ${MAX_FILE_BYTES} are allowed.`,
        file.path,
      );
    }
    totalBytes += file.bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return error(
        "total_too_large",
        `Upload totals ${totalBytes} bytes; at most ${MAX_TOTAL_BYTES} are allowed.`,
      );
    }
  }

  // 单根剥离:仅当顶层没有 SKILL.md 时才考虑;多个不同前缀无法确定唯一根
  let strippedRoot: string | null = null;
  if (!seen.has("SKILL.md")) {
    const roots = new Set(files.map((file) => file.path.split("/")[0] ?? ""));
    if (roots.size !== 1) {
      return error(
        "multi_root",
        "Cannot determine a single top-level directory: SKILL.md is missing at the top level and paths share no common root.",
      );
    }
    const root = [...roots][0]!;
    if (!seen.has(`${root}/SKILL.md`)) {
      return error(
        "missing_skill_md",
        `Upload must contain SKILL.md at the top level (or directly under "${root}").`,
        "SKILL.md",
      );
    }
    strippedRoot = root;
  }
  const strip = (path: string): string =>
    strippedRoot === null ? path : path.slice(strippedRoot.length + 1);

  const canonical = await Promise.all(
    files.map(async (file) => ({
      path: strip(file.path),
      bytes: file.bytes,
      size: file.bytes.length,
      sha256: await sha256Hex(file.bytes),
    })),
  );
  canonical.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const skillMd = canonical.find((file) => file.path === "SKILL.md");
  if (!skillMd) {
    // 剥离逻辑已保证存在;这是防御性兜底
    return error("missing_skill_md", "Upload must contain SKILL.md at the top level.", "SKILL.md");
  }
  const contentSha256 = await sha256Hex(
    new TextEncoder().encode(canonical.map((file) => `${file.path}\0${file.sha256}\n`).join("")),
  );
  return {
    ok: true,
    tree: {
      files: canonical,
      strippedRoot,
      fileCount: canonical.length,
      totalBytes,
      contentSha256,
      skillMd,
    },
  };
}
