import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { agentService } from "../service";

/** GET /v1/agents/{agentId} — 获取指定 Agent 的当前版本及完整配置 */
export async function getAgent(c: Context<AppEnv>) {
  // 路由已声明 :agentId,undefined 只在类型层面出现;空串查不到,自然走 404
  const agent = await agentService.getAgent(c.env, c.req.param("agentId") ?? "");
  return c.json(agent, 200);
}
