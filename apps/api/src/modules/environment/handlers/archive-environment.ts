import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { environmentService } from '../service';

/** POST /v1/environments/{environmentId}/archive — 幂等归档,返回归档后的完整环境 */
export async function archiveEnvironment(c: Context<AppEnv>) {
  // 路由已声明 :environmentId;空串查不到,自然走 404
  const environment = await environmentService.archiveEnvironment(
    c.env,
    c.req.param('environmentId') ?? '',
  );
  return c.json(environment, 200);
}
