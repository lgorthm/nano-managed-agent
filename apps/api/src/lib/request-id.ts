import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

/** 为每个请求生成 request_id,写入上下文(供错误信封使用)与 x-request-id 响应头 */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const id = `req_${crypto.randomUUID()}`;
  c.set("requestId", id);
  await next();
  c.res.headers.set("x-request-id", id);
});
