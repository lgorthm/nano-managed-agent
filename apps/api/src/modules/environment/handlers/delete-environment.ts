import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { environmentService } from "../service";

/** DELETE /v1/environments/{environmentId} — 硬删除,返回 environment_deleted 回执 */
export async function deleteEnvironment(c: Context<AppEnv>) {
  // 路由已声明 :environmentId;空串查不到,自然走 404
  const deleted = await environmentService.deleteEnvironment(c.env, c.req.param("environmentId") ?? "");
  return c.json(deleted, 200);
}
