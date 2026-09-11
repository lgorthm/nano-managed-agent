import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema";

/** 从 Worker 的 D1 绑定创建 Drizzle 实例;仓储函数统一接收它,便于测试注入 */
export function getDb(env: { DB: D1Database }) {
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof getDb>;
