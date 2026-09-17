import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseMultipart } from '../../../lib/multipart';
import { skillService } from '../service';

/** POST /v1/skills — 上传目录,创建 Skill 及其首个不可变版本 */
export async function createSkill(c: Context<AppEnv>) {
  const parsed = await parseMultipart(c);
  const skill = await skillService.createSkill(c.env, parsed);
  return c.json(skill, 201);
}
