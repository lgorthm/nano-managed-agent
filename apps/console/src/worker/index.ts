import { assertAccess } from "./access";
import type { Env } from "./env";
import { GLM_PROXY_PREFIX, proxyToGlm } from "./proxy";

/**
 * console worker 入口。静态资源与 SPA 回退由平台的 assets 路由处理,
 * worker 只接管未命中资源的 /glm/* 请求:先校验 Access JWT,再转发到 GLM。
 */
async function handleRequest(request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${GLM_PROXY_PREFIX}/`)) {
    return new Response("Not Found", { status: 404 });
  }

  const denied = await assertAccess(request, env);
  if (denied) return denied;

  return proxyToGlm(request, env, fetchImpl);
}

export { handleRequest };

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
