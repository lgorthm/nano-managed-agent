import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { sessionService } from "../service";

/** POST /v1/sessions/{sessionId}/archive — 归档会话(重复归档 409,非幂等) */
export async function archiveSession(c: Context<AppEnv>) {
  const session = await sessionService.archiveSession(c.env, c.req.param("sessionId") ?? "");
  return c.json(session, 200);
}
