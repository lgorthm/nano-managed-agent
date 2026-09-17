import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseListParams } from '../../../lib/pagination';
import { agentService } from '../service';

/** GET /v1/agents/{agentId}/versions — 分页列出历史版本(完整配置快照) */
export async function listAgentVersions(c: Context<AppEnv>) {
  // 路由已声明 :agentId;空串查不到,自然走 404
  const params = parseListParams((name) => c.req.query(name), 'agent-versions');
  const page = await agentService.listAgentVersions(c.env, c.req.param('agentId') ?? '', params);
  return c.json(page, 200);
}
