import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { skillService } from "../service";

/** GET /v1/skills/{skillId} — 获取 Skill 元数据与最新版本指针 */
export async function getSkill(c: Context<AppEnv>) {
  const skill = await skillService.getSkill(c.env, c.req.param("skillId") ?? "");
  return c.json(skill, 200);
}
