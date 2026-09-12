import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { sessionService } from "../service";

/** DELETE /v1/sessions/{sessionId}/resources/{resourceId} — 解除一个 File 挂载 */
export async function deleteSessionFileResource(c: Context<AppEnv>) {
  const deleted = await sessionService.deleteSessionFileResource(
    c.env,
    c.req.param("sessionId") ?? "",
    c.req.param("resourceId") ?? "",
  );
  return c.json(deleted, 200);
}
