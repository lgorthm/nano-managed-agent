import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { archiveAgent } from "./handlers/archive-agent";
import { createAgent } from "./handlers/create-agent";
import { getAgent } from "./handlers/get-agent";
import { listAgent } from "./handlers/list-agent";
import { listAgentVersions } from "./handlers/list-agent-versions";
import { updateAgent } from "./handlers/update-agent";

/** Agent 资源子路由;端点与 docs/agent/api/*.md 一一对应 */
export const agentRoutes = new Hono<AppEnv>();

agentRoutes.post("/", createAgent);
agentRoutes.get("/", listAgent);
agentRoutes.get("/:agentId/versions", listAgentVersions);
agentRoutes.post("/:agentId/archive", archiveAgent);
agentRoutes.get("/:agentId", getAgent);
agentRoutes.post("/:agentId", updateAgent);
