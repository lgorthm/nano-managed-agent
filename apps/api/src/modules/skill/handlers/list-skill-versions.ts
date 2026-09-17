import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseListParams } from '../../../lib/pagination';
import { skillService } from '../service';

/** GET /v1/skills/{skillId}/versions — 分页列出历史版本 */
export async function listSkillVersions(c: Context<AppEnv>) {
  const params = parseListParams((name) => c.req.query(name), 'skill-versions');
  const page = await skillService.listSkillVersions(c.env, c.req.param('skillId') ?? '', params);
  return c.json(page, 200);
}
