/**
 * Skill 资源的响应类型(设计见 docs/skills/api/README.md)。
 * 创建请求走 multipart/form-data,没有 JSON 请求 schema;
 * Agent 引用 Skill 的 SkillReference 已定义在 agent/schemas.ts,此处不重复。
 */

/** 版本路径参数 / wire 字段的合法形态:十进制数字字符串,无前导零,≤ 10 位 */
export const SKILL_VERSION_PATTERN = /^[1-9][0-9]{0,9}$/;

/** display_title 长度上限(仅创建时可设置) */
export const MAX_DISPLAY_TITLE_LENGTH = 256;

export interface SkillResponse {
  id: string;
  type: "skill";
  display_title: string | null;
  source: "custom" | "zai";
  latest_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillVersionResponse {
  id: string;
  type: "skill_version";
  skill_id: string;
  version: string;
  name: string;
  description: string;
  directory: string;
  created_at: string;
}

export interface SkillDeletedResponse {
  id: string;
  type: "skill_deleted";
}

export interface SkillVersionDeletedResponse {
  id: string;
  type: "skill_version_deleted";
}
