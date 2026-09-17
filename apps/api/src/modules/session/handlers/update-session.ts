import { SessionUpdateRequestSchema } from '@nano/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseAndValidateBody } from '../../../lib/body';
import { sessionService } from '../service';

/** POST /v1/sessions/{sessionId} — 更新 title/metadata/idle 态的 agent 工具配置 */
export async function updateSession(c: Context<AppEnv>) {
  const input = await parseAndValidateBody(c, SessionUpdateRequestSchema);
  const session = await sessionService.updateSession(c.env, c.req.param('sessionId') ?? '', input);
  return c.json(session, 200);
}
