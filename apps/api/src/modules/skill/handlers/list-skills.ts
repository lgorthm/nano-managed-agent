import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { invalidRequestError } from '../../../lib/errors';
import { parseListParams } from '../../../lib/pagination';
import { skillService } from '../service';

/** GET /v1/skills — 分页列出 Skill,支持 source 过滤 */
export async function listSkills(c: Context<AppEnv>) {
  const params = parseListParams((name) => c.req.query(name), 'skills');
  const rawSource = c.req.query('source');
  let source: 'custom' | 'zai' | undefined;
  if (rawSource !== undefined) {
    if (rawSource !== 'custom' && rawSource !== 'zai') {
      throw invalidRequestError('Query parameter source must be custom or zai.');
    }
    source = rawSource;
  }
  const page = await skillService.listSkills(c.env, { ...params, source });
  return c.json(page, 200);
}
