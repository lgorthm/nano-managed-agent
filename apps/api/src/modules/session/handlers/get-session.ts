import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { sessionService } from "../service";

/** GET /v1/sessions/{sessionId} — 获取会话(归档的会话同样可读) */
export async function getSession(c: Context<AppEnv>) {
  const session = await sessionService.getSession(c.env, c.req.param("sessionId") ?? "");
  return c.json(session, 200);
}
