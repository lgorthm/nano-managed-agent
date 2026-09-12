import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { archiveEnvironment } from "./handlers/archive-environment";
import { createEnvironment } from "./handlers/create-environment";
import { deleteEnvironment } from "./handlers/delete-environment";
import { getEnvironment } from "./handlers/get-environment";
import { listEnvironment } from "./handlers/list-environment";
import { updateEnvironment } from "./handlers/update-environment";

/** Environment 资源子路由;端点与 docs/environment/api/*.md 一一对应 */
export const environmentRoutes = new Hono<AppEnv>();

environmentRoutes.post("/", createEnvironment);
environmentRoutes.get("/", listEnvironment);
// archive 路径更长,先注册避免被 :environmentId 捕获
environmentRoutes.post("/:environmentId/archive", archiveEnvironment);
environmentRoutes.delete("/:environmentId", deleteEnvironment);
environmentRoutes.get("/:environmentId", getEnvironment);
environmentRoutes.post("/:environmentId", updateEnvironment);
