import type { Context } from "hono";
import { AgentCreateRequestSchema } from "@nano/shared";
import type { AppEnv } from "../../../env";
import { parseAndValidateBody } from "../../../lib/body";
import { agentService } from "../service";

/** POST /v1/agents — 创建 Agent 及其首个不可变版本 */
export async function createAgent(c: Context<AppEnv>) {
  const input = await parseAndValidateBody(c, AgentCreateRequestSchema);
  const agent = await agentService.createAgent(c.env, input);
  return c.json(agent, 201);
}
