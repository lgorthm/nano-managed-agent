/**
 * Skill 资源类型。见 references/skills.md 与
 * references/api/{create-skill,list-skills,get-skill}.md、
 * {create-skill-version,list-skill-versions,get-skill-version}.md、
 * {download-skill-zip,delete-skill,delete-skill-version}.md。
 */
import type { ListQuery } from "./common";

export type SkillSource = "custom" | "zai";

/** 上传目录内的单个文件;路径即 multipart 字段名 */
export interface SkillFileInput {
  /** Skill 内相对路径,全部文件须位于同一顶层目录下(如 `pdf-tools/SKILL.md`、`pdf-tools/scripts/run.py`) */
  path: string;
  file: Blob;
}

/** create-skill 的 multipart 输入 */
export interface SkillCreateInput {
  /** 可选展示名(≤ 256 字符) */
  displayTitle?: string;
  files: SkillFileInput[];
}

export interface Skill {
  id: string;
  type: "skill";
  /** 可选展示名;null 时界面回退到最新版本的 frontmatter name */
  display_title: string | null;
  source: SkillSource;
  /** 最新版本号(十进制字符串);删空的空壳 Skill 为 null */
  latest_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillVersion {
  id: string;
  type: "skill_version";
  skill_id: string;
  /** 十进制数字字符串("1"、"2"…),单调递增 */
  version: string;
  /** 来自 SKILL.md frontmatter,上传时冻结在该版本 */
  name: string;
  description: string;
  /** 单根前缀剥离后的根目录名,无前缀时等于 frontmatter name */
  directory: string;
  created_at: string;
}

/** ManagedSkillPage:比通用分页信封多一个必填 has_more */
export interface SkillPage {
  data: Skill[];
  next_page: string | null;
  has_more: boolean;
}

export interface SkillListQuery extends ListQuery {
  /** 按来源过滤;nano 单租户恒为 custom */
  source?: SkillSource;
}

export interface SkillDeleted {
  id: string;
  type: "skill_deleted";
}

export interface SkillVersionDeleted {
  id: string;
  type: "skill_version_deleted";
}
