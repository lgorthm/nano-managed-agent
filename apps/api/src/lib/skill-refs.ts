/**
 * Skill 引用可解析性校验(docs/skills/schema.md 的引用一致性规则)。
 * Agent 创建/更新与会话创建都会校验 skills 引用,共享逻辑提升到 lib/
 * (结构规则:跨模块逻辑下沉 @nano/shared 或提升 lib/,不做模块横向引用)。
 */
import { findMissingSkillVersionPairs, type Db } from "@nano/db";
import type { SkillReference } from "@nano/shared";
import { invalidRequestError } from "./errors";

/** zai 平台内置 Skill 在 nano 不存在,直接拒绝;custom 引用逐个点查 (skill_id, version) */
export async function assertSkillReferencesResolvable(db: Db, skills: SkillReference[]): Promise<void> {
  const unsupported = skills.filter((reference) => reference.type !== "custom");
  if (unsupported.length > 0) {
    throw invalidRequestError(
      'Skill references with type "zai" are not supported: nano has no platform built-in skills.',
      { references: unsupported },
    );
  }
  if (skills.length === 0) return;
  const missing = await findMissingSkillVersionPairs(db, skills);
  if (missing.size > 0) {
    throw invalidRequestError("Skill references are not resolvable.", {
      missing: [...missing].map((key) => {
        const [type, skill_id, version] = key.split("|");
        return { type, skill_id, version };
      }),
    });
  }
}
