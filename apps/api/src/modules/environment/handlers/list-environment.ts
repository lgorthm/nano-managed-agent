import type { Context } from "hono";
import type { AppEnv } from "../../../env";
import { parseListParams } from "../../../lib/pagination";
import { environmentService } from "../service";

/** GET /v1/environments — 分页列出全部 Environment(含已归档) */
export async function listEnvironment(c: Context<AppEnv>) {
  const params = parseListParams((name) => c.req.query(name), "environments");
  const page = await environmentService.listEnvironments(c.env, params);
  return c.json(page, 200);
}
