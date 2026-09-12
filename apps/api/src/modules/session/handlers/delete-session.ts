import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { sessionService } from "../service";

/** DELETE /v1/sessions/{sessionId} — 硬删除会话及挂载记录(已归档会话可删) */
export async function deleteSession(c: Context<AppEnv>) {
  const deleted = await sessionService.deleteSession(c.env, c.req.param("sessionId") ?? "");
  return c.json(deleted, 200);
}
