import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseSkillVersionParam, skillService } from '../service';

/** GET /v1/skills/{skillId}/versions/{version} — 获取版本元数据 */
export async function getSkillVersion(c: Context<AppEnv>) {
  const version = parseSkillVersionParam(c.req.param('version') ?? '');
  const body = await skillService.getSkillVersion(c.env, c.req.param('skillId') ?? '', version);
  return c.json(body, 200);
}
