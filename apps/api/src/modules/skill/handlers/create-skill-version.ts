import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseMultipart } from '../../../lib/multipart';
import { skillService } from '../service';

/** POST /v1/skills/{skillId}/versions — 重新上传完整目录,创建新版本 */
export async function createSkillVersion(c: Context<AppEnv>) {
  const parsed = await parseMultipart(c);
  const version = await skillService.createSkillVersion(
    c.env,
    c.req.param('skillId') ?? '',
    parsed,
  );
  return c.json(version, 201);
}
