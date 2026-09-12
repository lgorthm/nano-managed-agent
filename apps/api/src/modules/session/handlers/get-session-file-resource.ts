import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { sessionService } from "../service";

/** GET /v1/sessions/{sessionId}/resources/{resourceId} — 获取单个挂载资源 */
export async function getSessionFileResource(c: Context<AppEnv>) {
  const resource = await sessionService.getSessionFileResource(
    c.env,
    c.req.param("sessionId") ?? "",
    c.req.param("resourceId") ?? "",
  );
  return c.json(resource, 200);
}
