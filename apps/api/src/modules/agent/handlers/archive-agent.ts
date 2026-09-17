import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { agentService } from '../service';

/** POST /v1/agents/{agentId}/archive — 幂等归档,返回归档后的完整 Agent */
export async function archiveAgent(c: Context<AppEnv>) {
  // 路由已声明 :agentId;空串查不到,自然走 404
  const agent = await agentService.archiveAgent(c.env, c.req.param('agentId') ?? '');
  return c.json(agent, 200);
}
