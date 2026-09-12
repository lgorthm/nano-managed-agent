import type { Context } from "hono";
import { SessionCreateRequestSchema } from "@nano/shared";
import type { AppEnv } from "../../../env";
import { parseAndValidateBody } from "../../../lib/body";
import { sessionService } from "../service";

/** POST /v1/sessions — 创建会话并固化 Agent / Environment 快照 */
export async function createSession(c: Context<AppEnv>) {
  const input = await parseAndValidateBody(c, SessionCreateRequestSchema);
  const session = await sessionService.createSession(c.env, input);
  return c.json(session, 201);
}
