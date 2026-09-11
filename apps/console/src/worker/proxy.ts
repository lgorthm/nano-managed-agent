import type { Env } from "./env";
import { GLM_API_BASE, ZAI_BETA_HEADER, ZAI_VERSION_HEADER } from "@nano/shared/glm";

export const GLM_PROXY_PREFIX = "/glm";

/** 不应透传给上游的请求头(本站 Cookie、Access 痕迹与逐跳头) */
const SKIPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "cf-access-jwt-assertion",
  "accept-encoding",
  "content-length",
  "connection",
]);

/** 不应回传给浏览器的响应头 */
const SKIPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "connection",
]);

export function buildUpstreamUrl(url: URL): URL {
  // /glm/<rest> → https://agent-api.bigmodel.cn/api/<rest>
  return new URL(GLM_API_BASE + url.pathname.slice(GLM_PROXY_PREFIX.length) + url.search);
}

export function buildUpstreamRequest(request: Request, url: URL, apiKey: string): Request {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (SKIPPED_REQUEST_HEADERS.has(k) || k.startsWith("cf-") || k.startsWith("x-forwarded-")) {
      return;
    }
    headers.set(key, value);
  });
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("zai-version", ZAI_VERSION_HEADER);
  headers.set("zai-beta", ZAI_BETA_HEADER);

  // 用原始 body 流构造(GET/HEAD 的 body 为 null),multipart 上传与 SSE 均天然透传
  return new Request(buildUpstreamUrl(url), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

/** fetch 可注入:测试用它替换成 stub,避免依赖网络 mock 基建 */
export async function proxyToGlm(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const upstream = await fetchImpl(buildUpstreamRequest(request, url, env.GLM_API_KEY));

  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!SKIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  // 不碰 upstream.body:SSE 事件流靠流式透传,读出来就会退化成一次性响应
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
