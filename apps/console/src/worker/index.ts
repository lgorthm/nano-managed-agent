import { assertAccess } from './access';
import type { Env } from './env';
import { GLM_PROXY_PREFIX, NANO_PROXY_PREFIX, proxyToGlm, proxyToNano } from './proxy';

/**
 * console worker 入口。静态资源与 SPA 回退由平台的 assets 路由处理,
 * worker 只接管未命中资源的 /glm/* 与 /nano/* 请求:
 * 先校验 Access JWT,再分别转发到 GLM / nano 上游(后端由 sidebar 底部 Select 切换)。
 */
function proxyPrefixOf(pathname: string): string | null {
  if (pathname.startsWith(`${GLM_PROXY_PREFIX}/`)) return GLM_PROXY_PREFIX;
  if (pathname.startsWith(`${NANO_PROXY_PREFIX}/`)) return NANO_PROXY_PREFIX;
  return null;
}

async function handleRequest(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const prefix = proxyPrefixOf(new URL(request.url).pathname);
  if (prefix === null) {
    return new Response('Not Found', { status: 404 });
  }

  const denied = await assertAccess(request, env);
  if (denied) return denied;

  return prefix === GLM_PROXY_PREFIX
    ? proxyToGlm(request, env, fetchImpl)
    : proxyToNano(request, env, fetchImpl);
}

export { handleRequest };

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
