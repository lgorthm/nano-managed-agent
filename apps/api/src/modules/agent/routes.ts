import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { createAgent } from "./handlers/create-agent";

/** Agent 资源子路由;端点与 docs/agent/api/*.md 一一对应 */
export const agentRoutes = new Hono<AppEnv>();

agentRoutes.post("/", createAgent);
