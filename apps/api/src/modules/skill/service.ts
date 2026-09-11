import {
  createSkillWithFirstVersion,
  deleteSkillCascade,
  deleteSkillVersionAndRetarget,
  findSkill,
  findSkillVersion,
  getDb,
  insertNextSkillVersionAndAdvance,
  isSkillReferenced,
  isSkillVersionReferenced,
  listSkillFiles,
  listSkillsPage,
  listSkillVersionsPage,
  newSkillId,
  newSkillVersionId,
} from "@nano/db";
import type {
  CanonicalSkillTree,
  Page,
  RawSkillFile,
  SkillDeletedResponse,
  SkillResponse,
  SkillTreeError,
  SkillVersionDeletedResponse,
  SkillVersionResponse,
} from "@nano/shared";
import {
  MAX_DISPLAY_TITLE_LENGTH,
  SKILL_VERSION_PATTERN,
  normalizeSkillTree,
  parseSkillFrontmatter,
} from "@nano/shared";
import type { Env } from "../../env";
import {
  conflictError,
  invalidRequestError,
  notFoundError,
  requestTooLargeError,
} from "../../lib/errors";
import { cursorNumberField, cursorStringField, encodeCursor, type ListParams } from "../../lib/pagination";
import { serializeSkill, serializeSkillVersion } from "./serialize";
import { buildSkillZip } from "./zip";

/** skills 列表游标的 kind 前缀,防止与其他列表端点的游标混用 */
const SKILLS_CURSOR_KIND = "skills";

/** skill 版本列表游标的 kind 前缀 */
const SKILL_VERSIONS_CURSOR_KIND = "skill-versions";

/** 规范树错误 → API 错误:尺寸类转 413,形态类转 400 */
function throwTreeError({ code, message, param }: SkillTreeError): never {
  const details = param === undefined ? undefined : { param };
  if (code === "file_too_large" || code === "total_too_large") {
    throw requestTooLargeError(message, details);
  }
  throw invalidRequestError(message, details);
}

/** 规范树 + frontmatter 的共同上传链:归一化 → 解析 SKILL.md → 得出版本元数据 */
async function buildVersionMeta(files: RawSkillFile[]): Promise<{
  tree: CanonicalSkillTree;
  meta: { name: string; description: string; directory: string };
}> {
  const treeResult = await normalizeSkillTree(files);
  if (!treeResult.ok) throwTreeError(treeResult.error);
  const frontmatter = parseSkillFrontmatter(treeResult.tree.skillMd.bytes);
  if (!frontmatter.ok) {
    throw invalidRequestError(`SKILL.md is invalid: ${frontmatter.error.message}`, { param: "SKILL.md" });
  }
  const directory = treeResult.tree.strippedRoot ?? frontmatter.data.name;
  return { tree: treeResult.tree, meta: { ...frontmatter.data, directory } };
}

/**
 * 版本路径参数:十进制数字字符串。非法形态(01、1a)是 400,
 * 与「合法但不存在」的 404 区分开。
 */
export function parseSkillVersionParam(raw: string): number {
  if (!SKILL_VERSION_PATTERN.test(raw)) {
    throw invalidRequestError(`Invalid version "${raw}": must be a decimal version number.`, {
      param: "version",
    });
  }
  return Number(raw);
}

/** 端点允许的文本字段之外的键一律 400;返回被允许字段的取值 */
function allowedTextFields(
  textFields: Record<string, string>,
  allowed: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(textFields)) {
    if (!allowed.includes(name)) {
      throw invalidRequestError(`Unknown multipart text field "${name}".`, { param: name });
    }
    result[name] = value;
  }
  return result;
}

/** Skill 资源的业务编排层。上传链:multipart 解析(handler)→ 归一化 → frontmatter → 落库。 */
export const skillService = {
  /** 创建 Skill 及首个版本;display_title 仅此处可设置 */
  async createSkill(
    env: Env,
    input: { textFields: Record<string, string>; files: RawSkillFile[] },
  ): Promise<SkillResponse> {
    const textFields = allowedTextFields(input.textFields, ["display_title"]);
    const displayTitle = textFields["display_title"];
    if (displayTitle !== undefined && displayTitle.length > MAX_DISPLAY_TITLE_LENGTH) {
      throw invalidRequestError(
        `display_title exceeds ${MAX_DISPLAY_TITLE_LENGTH} characters.`,
        { param: "display_title" },
      );
    }
    const { tree, meta } = await buildVersionMeta(input.files);
    const db = getDb(env);
    const skillId = newSkillId();
    const versionId = newSkillVersionId();
    const now = new Date();
    await createSkillWithFirstVersion(db, {
      skillId,
      versionId,
      displayTitle: displayTitle ?? null,
      meta,
      tree,
      now,
    });
    return {
      id: skillId,
      type: "skill",
      display_title: displayTitle ?? null,
      source: "custom",
      latest_version: "1",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
  },

  /** 获取 Skill 元数据与最新版本指针;不存在时抛 404 */
  async getSkill(env: Env, skillId: string): Promise<SkillResponse> {
    const row = await findSkill(getDb(env), skillId);
    if (!row) {
      throw notFoundError(`Skill "${skillId}" not found.`);
    }
    return serializeSkill(row);
  },

  /** 分页列出 Skill(含空壳),按 (created_at, id) 排序,支持 source 过滤 */
  async listSkills(
    env: Env,
    params: ListParams & { source?: "custom" | "zai" },
  ): Promise<Page<SkillResponse>> {
    const cursor =
      params.cursor === null
        ? null
        : {
            createdAt: cursorNumberField(params.cursor, "createdAt"),
            id: cursorStringField(params.cursor, "id"),
          };
    const { rows, nextCursor } = await listSkillsPage(getDb(env), {
      source: params.source,
      limit: params.limit,
      order: params.order,
      cursor,
    });
    return {
      data: rows.map(serializeSkill),
      next_page: nextCursor
        ? encodeCursor({ kind: SKILLS_CURSOR_KIND, createdAt: nextCursor.createdAt, id: nextCursor.id })
        : null,
    };
  },

  /**
   * 上传新版本:版本号由 next_version 分配器单调分配(删除后不复用)。
   * 并发上传抢号时 CAS 失败 → 409,重试即可;空壳 Skill 也能继续上传。
   */
  async createSkillVersion(
    env: Env,
    skillId: string,
    input: { textFields: Record<string, string>; files: RawSkillFile[] },
  ): Promise<SkillVersionResponse> {
    allowedTextFields(input.textFields, []);
    const db = getDb(env);
    const skill = await findSkill(db, skillId);
    if (!skill) {
      throw notFoundError(`Skill "${skillId}" not found.`);
    }
    const { tree, meta } = await buildVersionMeta(input.files);
    const versionId = newSkillVersionId();
    const now = new Date();
    const advanced = await insertNextSkillVersionAndAdvance(db, {
      skillId,
      expectedVersion: skill.nextVersion,
      versionId,
      meta,
      tree,
      now,
    });
    if (!advanced) {
      throw conflictError(
        `Version conflict: skill "${skillId}" was uploaded concurrently. Retry the upload.`,
      );
    }
    return {
      id: versionId,
      type: "skill_version",
      skill_id: skillId,
      version: String(skill.nextVersion),
      name: meta.name,
      description: meta.description,
      directory: meta.directory,
      created_at: now.toISOString(),
    };
  },

  /** 分页列出指定 Skill 的历史版本,按 version 数字序 */
  async listSkillVersions(
    env: Env,
    skillId: string,
    params: ListParams,
  ): Promise<Page<SkillVersionResponse>> {
    const db = getDb(env);
    const skill = await findSkill(db, skillId);
    if (!skill) {
      throw notFoundError(`Skill "${skillId}" not found.`);
    }
    const cursor = params.cursor === null ? null : cursorNumberField(params.cursor, "version");
    const { rows, nextCursor } = await listSkillVersionsPage(db, skillId, {
      limit: params.limit,
      order: params.order,
      cursor,
    });
    return {
      data: rows.map(serializeSkillVersion),
      next_page:
        nextCursor === null
          ? null
          : encodeCursor({ kind: SKILL_VERSIONS_CURSOR_KIND, version: nextCursor }),
    };
  },

  /** 获取版本元数据;Skill 不存在与版本不存在同返回 404 */
  async getSkillVersion(env: Env, skillId: string, version: number): Promise<SkillVersionResponse> {
    const row = await findSkillVersion(getDb(env), skillId, version);
    if (!row) {
      throw notFoundError(`Skill "${skillId}" version ${version} not found.`);
    }
    return serializeSkillVersion(row);
  },

  /** 下载版本的 ZIP 内容;返回字节与响应头所需的元数据 */
  async downloadSkillZip(
    env: Env,
    skillId: string,
    version: number,
  ): Promise<{ bytes: Uint8Array; directory: string; version: string; etag: string }> {
    const db = getDb(env);
    const versionRow = await findSkillVersion(db, skillId, version);
    if (!versionRow) {
      throw notFoundError(`Skill "${skillId}" version ${version} not found.`);
    }
    const files = await listSkillFiles(db, skillId, version);
    const bytes = buildSkillZip(
      versionRow.directory,
      files.map((file) => ({ path: file.path, bytes: file.content })),
      versionRow.createdAt,
    );
    return { bytes, directory: versionRow.directory, version: String(version), etag: versionRow.contentSha256 };
  },

  /**
   * 删除指定版本:被任何 Agent 版本快照引用时拒绝(400);
   * 删除最新版本时指针在同一个事务内重指,无剩余则置空(空壳)。
   */
  async deleteSkillVersion(
    env: Env,
    skillId: string,
    version: number,
  ): Promise<SkillVersionDeletedResponse> {
    const db = getDb(env);
    const versionRow = await findSkillVersion(db, skillId, version);
    if (!versionRow) {
      throw notFoundError(`Skill "${skillId}" version ${version} not found.`);
    }
    if (await isSkillVersionReferenced(db, skillId, version)) {
      throw invalidRequestError(
        `Skill version "${skillId}@${version}" is referenced by an agent configuration and cannot be deleted.`,
        { skill_id: skillId, version: String(version) },
      );
    }
    await deleteSkillVersionAndRetarget(db, { skillId, version, now: new Date() });
    return { id: versionRow.id, type: "skill_version_deleted" };
  },

  /** 级联删除 Skill 及全部版本与文件;被任意版本引用时拒绝(400) */
  async deleteSkill(env: Env, skillId: string): Promise<SkillDeletedResponse> {
    const db = getDb(env);
    const skill = await findSkill(db, skillId);
    if (!skill) {
      throw notFoundError(`Skill "${skillId}" not found.`);
    }
    if (await isSkillReferenced(db, skillId)) {
      throw invalidRequestError(
        `Skill "${skillId}" is referenced by an agent configuration and cannot be deleted.`,
        { skill_id: skillId },
      );
    }
    await deleteSkillCascade(db, skillId);
    return { id: skillId, type: "skill_deleted" };
  },
};
