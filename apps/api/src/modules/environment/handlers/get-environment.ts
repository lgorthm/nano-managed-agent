import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { environmentService } from '../service';

/** GET /v1/environments/{environmentId} — 获取完整环境(归档的同样可读) */
export async function getEnvironment(c: Context<AppEnv>) {
  // 路由已声明 :environmentId,undefined 只在类型层面出现;空串查不到,自然走 404
  const environment = await environmentService.getEnvironment(
    c.env,
    c.req.param('environmentId') ?? '',
  );
  return c.json(environment, 200);
}
