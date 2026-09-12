import type { Context } from "hono";
import { EnvironmentUpdateRequestSchema } from "@nano/shared";
import type { AppEnv } from "../../../env";
import { parseAndValidateOptionalBody } from "../../../lib/body";
import { environmentService } from "../service";

/** POST /v1/environments/{environmentId} — 更新;空请求体是合法空补丁 */
export async function updateEnvironment(c: Context<AppEnv>) {
  // 路由已声明 :environmentId;空串查不到,自然走 404
  const input = await parseAndValidateOptionalBody(c, EnvironmentUpdateRequestSchema);
  const environment = await environmentService.updateEnvironment(
    c.env,
    c.req.param("environmentId") ?? "",
    input,
  );
  return c.json(environment, 200);
}
