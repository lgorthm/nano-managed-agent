import type { SkillRow, SkillVersionRow } from '@nano/db';
import type { SkillResponse, SkillVersionResponse } from '@nano/shared';

/**
 * Skill 行到 API JSON 的唯一序列化出口:
 * 时间戳转 ISO 8601 UTC,注入不落库的固定字段 type,
 * 版本号在边界处转写(库内整数 → wire 字符串,NULL 保持 null)。
 */
export function serializeSkill(row: SkillRow): SkillResponse {
  return {
    id: row.id,
    type: 'skill',
    display_title: row.displayTitle,
    source: row.source as SkillResponse['source'],
    latest_version: row.latestVersionSeq === null ? null : String(row.latestVersionSeq),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function serializeSkillVersion(row: SkillVersionRow): SkillVersionResponse {
  return {
    id: row.id,
    type: 'skill_version',
    skill_id: row.skillId,
    version: String(row.version),
    name: row.name,
    description: row.description,
    directory: row.directory,
    created_at: row.createdAt.toISOString(),
  };
}
