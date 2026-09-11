import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { ApiError } from "./errors";

/** 长度不同直接失败;等长时按位异或,耗时与内容无关 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Bearer API_KEY 校验;所有 /v1 路由都注册在该中间件之后 */
export const auth = createMiddleware<AppEnv>(async (c, next) => {
  const expected = c.env.API_KEY;
  if (!expected) {
    throw new ApiError("api_error", "API_KEY is not configured on the server.");
  }
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (token === null || !safeEqual(token, expected)) {
    throw new ApiError("authentication_error", "Missing or invalid bearer token.");
  }
  await next();
});
