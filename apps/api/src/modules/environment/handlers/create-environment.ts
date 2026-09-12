import type { Context } from "hono";
import { EnvironmentCreateRequestSchema } from "@nano/shared";
import type { AppEnv } from "../../../env";
import { parseAndValidateBody } from "../../../lib/body";
import { environmentService } from "../service";

/** POST /v1/environments — 创建 Environment,回显归一化后的完整配置 */
export async function createEnvironment(c: Context<AppEnv>) {
  const input = await parseAndValidateBody(c, EnvironmentCreateRequestSchema);
  const environment = await environmentService.createEnvironment(c.env, input);
  return c.json(environment, 201);
}
