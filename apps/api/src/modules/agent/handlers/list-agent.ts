import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { parseListParams } from "../../../lib/pagination";
import { agentService } from "../service";

/** GET /v1/agents — 分页列出全部 Agent(含已归档) */
export async function listAgent(c: Context<AppEnv>) {
  const params = parseListParams((name) => c.req.query(name), "agents");
  const page = await agentService.listAgents(c.env, params);
  return c.json(page, 200);
}
