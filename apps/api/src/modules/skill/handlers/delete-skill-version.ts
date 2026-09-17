import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseSkillVersionParam, skillService } from '../service';

/** DELETE /v1/skills/{skillId}/versions/{version} — 删除版本并重指最新版本指针 */
export async function deleteSkillVersion(c: Context<AppEnv>) {
  const version = parseSkillVersionParam(c.req.param('version') ?? '');
  const receipt = await skillService.deleteSkillVersion(
    c.env,
    c.req.param('skillId') ?? '',
    version,
  );
  return c.json(receipt, 200);
}
