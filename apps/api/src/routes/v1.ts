import { Hono } from "hono";
import { API_VERSION } from "@nano/shared";
import type { AppEnv } from "../env";
import { auth } from "../lib/auth";
import { agentRoutes } from "../modules/agent/routes";
import { environmentRoutes } from "../modules/environment/routes";
import { fileRoutes } from "../modules/file/routes";
import { sessionRoutes } from "../modules/session/routes";
import { skillRoutes } from "../modules/skill/routes";

/** /v1 子应用;各资源模块的子路由在这里挂载 */
export const v1 = new Hono<AppEnv>();

// 所有 /v1 路由(含探测路由)都在认证之后
v1.use("*", auth);

v1.get("/", (c) => c.json({ service: "nano-managed-agent", version: API_VERSION }));

v1.route("/agents", agentRoutes);
v1.route("/skills", skillRoutes);
v1.route("/files", fileRoutes);
v1.route("/environments", environmentRoutes);
v1.route("/sessions", sessionRoutes);
