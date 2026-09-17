import { AgentUpdateRequestSchema } from '@nano/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../../env';
import { parseAndValidateBody } from '../../../lib/body';
import { agentService } from '../service';

/** POST /v1/agents/{agentId} — 更新并在配置变化时生成新的不可变版本 */
export async function updateAgent(c: Context<AppEnv>) {
  // 路由已声明 :agentId;空串查不到,自然走 404
  const input = await parseAndValidateBody(c, AgentUpdateRequestSchema);
  const agent = await agentService.updateAgent(c.env, c.req.param('agentId') ?? '', input);
  return c.json(agent, 200);
}
