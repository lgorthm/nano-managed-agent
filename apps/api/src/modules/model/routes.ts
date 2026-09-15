import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { listModels } from "./handlers/list-models";

/** 模型目录子路由:console 创建/编辑 Agent 的可选模型来源 */
export const modelRoutes = new Hono<AppEnv>();

modelRoutes.get("/", listModels);
