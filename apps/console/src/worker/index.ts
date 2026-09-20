import { tracing } from 'cloudflare:workers';
import { log, resolveRequestId, withRequestId } from '@nano/shared/log';
import { assertAccess } from './access';
import type { Env } from './env';
import {
  GLM_PROXY_PREFIX,
  NANO_PROXY_PREFIX,
  proxyToGlm,
  proxyToNano,
  upstreamFailureResponse,
} from './proxy';

/**
 * console worker 入口。静态资源与 SPA 回退由平台的 assets 路由处理,
 * worker 只接管未命中资源的 /glm/* 与 /nano/* 请求:
 * 先校验 Access JWT,再分别转发到 GLM / nano 上游(后端由 sidebar 底部 Select 切换)。
 *
 * request_id 装配(与 apps/api 的 request-id.ts 同一模式):
 * 生成/沿用 id → ALS 包裹(作用域内 log.* 自动携带 requestId)→ span 属性
 * app.request_id 桥进 trace(跨 Service Binding 的 trace 上下文由平台自动传播)
 * → 所有响应(含 401/404/502)回带 x-request-id;转发上游时由 proxy.ts
 * 沿用同一 id,浏览器 → console → nano-api 全链路共享。
 */
function proxyPrefixOf(pathname: string): string | null {
  if (pathname.startsWith(`${GLM_PROXY_PREFIX}/`)) return GLM_PROXY_PREFIX;
  if (pathname.startsWith(`${NANO_PROXY_PREFIX}/`)) return NANO_PROXY_PREFIX;
  return null;
}

async function dispatch(
  prefix: string | null,
  request: Request,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (prefix === null) {
    return new Response('Not Found', { status: 404 });
  }
  const denied = await assertAccess(request, env);
  if (denied) return denied;
  return prefix === GLM_PROXY_PREFIX
    ? proxyToGlm(request, env, fetchImpl)
    : proxyToNano(request, env, fetchImpl);
}

async function handleRequest(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const prefix = proxyPrefixOf(url.pathname);
  const id = resolveRequestId(request.headers.get('x-request-id'));
  const startedAt = Date.now();
  return tracing.enterSpan('app.request', async (span) => {
    span.setAttribute('app.request_id', id);
    span.setAttribute('http.request.method', request.method);
    span.setAttribute('url.path', url.pathname);
    return withRequestId(id, async () => {
      const complete = (status: number): void => {
        if (env.LOG_REQUEST_COMPLETION !== '0') {
          log.info('request completed', {
            method: request.method,
            path: url.pathname,
            status,
            durationMs: Date.now() - startedAt,
          });
        }
      };
      try {
        const response = await dispatch(prefix, request, env, fetchImpl);
        response.headers.set('x-request-id', id);
        complete(response.status);
        return response;
      } catch (err) {
        // 与 proxy 层的 502 收敛同语义:不让异常裸抛成无上下文的平台 exception
        log.error('request failed', { err });
        const response = upstreamFailureResponse();
        response.headers.set('x-request-id', id);
        complete(response.status);
        return response;
      }
    });
  });
}

export { handleRequest };

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
} satisfies ExportedHandler<Env>;
