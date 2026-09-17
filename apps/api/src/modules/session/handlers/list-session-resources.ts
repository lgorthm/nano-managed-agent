import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseListParams } from '../../../lib/pagination';
import { sessionService } from '../service';

/** GET /v1/sessions/{sessionId}/resources — 分页列出会话的挂载资源 */
export async function listSessionResources(c: Context<AppEnv>) {
  const params = parseListParams((name) => c.req.query(name), 'session-resources');
  const page = await sessionService.listSessionResources(
    c.env,
    c.req.param('sessionId') ?? '',
    params,
  );
  return c.json(page, 200);
}
