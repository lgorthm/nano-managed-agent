import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { skillService } from "../service";

/** DELETE /v1/skills/{skillId} — 级联删除 Skill 及全部版本与文件 */
export async function deleteSkill(c: Context<AppEnv>) {
  const receipt = await skillService.deleteSkill(c.env, c.req.param("skillId") ?? "");
  return c.json(receipt, 200);
}
