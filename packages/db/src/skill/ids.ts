/**
 * Skill 资源标识:skill_ / skv_ 前缀 + UUIDv7,形态与 agent_ 一致。
 */
import { uuidv7 } from "../uuid";

export function newSkillId(): string {
  return `skill_${uuidv7()}`;
}

export function newSkillVersionId(): string {
  return `skv_${uuidv7()}`;
}
