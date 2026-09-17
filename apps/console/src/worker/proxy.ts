import { GLM_API_BASE, ZAI_BETA_HEADER, ZAI_VERSION_HEADER } from '@nano/shared/glm';
import type { Env } from './env';

export const GLM_PROXY_PREFIX = '/glm';
export const NANO_PROXY_PREFIX = '/nano';

/** 浏览器侧固守 GLM 路径形状,资源段固定出现在该前缀之后;nano 分支据此改写路径 */
const GLM_RESOURCE_PREFIX = '/agent/managed/v1';

/** 不应透传给上游的请求头(本站 Cookie、Access 痕迹与逐跳头) */
const SKIPPED_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'cf-access-jwt-assertion',
  'accept-encoding',
  'content-length',
  'connection',
]);

/** 不应回传给浏览器的响应头 */
const SKIPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'connection',
]);

// /glm/<rest> → https://agent-api.bigmodel.cn/api/<rest>
export function buildUpstreamUrl(url: URL): URL {
  return new URL(GLM_API_BASE + url.pathname.slice(GLM_PROXY_PREFIX.length) + url.search);
}

// /nano/agent/managed/v1/<rest> → ${NANO_API_BASE}/v1/<rest>;其余路径原样透传
export function buildNanoUpstreamUrl(url: URL, nanoApiBase: string): URL {
  const rest = url.pathname.slice(NANO_PROXY_PREFIX.length);
  const path =
    rest === GLM_RESOURCE_PREFIX || rest.startsWith(`${GLM_RESOURCE_PREFIX}/`)
      ? `/v1${rest.slice(GLM_RESOURCE_PREFIX.length)}`
      : rest;
  return new URL(nanoApiBase + path + url.search);
}

export function buildUpstreamRequest(
  request: Request,
  upstreamUrl: URL,
  apiKey: string,
  zaiProtocol = true,
): Request {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (SKIPPED_REQUEST_HEADERS.has(k) || k.startsWith('cf-') || k.startsWith('x-forwarded-')) {
      return;
    }
    headers.set(key, value);
  });
  headers.set('Authorization', `Bearer ${apiKey}`);
  if (zaiProtocol) {
    // zai 协议头仅 GLM 需要;nano 的版本由 /v1 路径承载,不认识这些头
    headers.set('zai-version', ZAI_VERSION_HEADER);
    headers.set('zai-beta', ZAI_BETA_HEADER);
  }

  // 用原始 body 流构造(GET/HEAD 的 body 为 null),multipart 上传与 SSE 均天然透传
  return new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  });
}

/** 过滤逐跳响应头后流式透传 upstream(SSE 事件流与 ZIP 下载都依赖 body 不落地) */
function passthroughResponse(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!SKIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/** fetch 可注入:测试用它替换成 stub,避免依赖网络 mock 基建 */
export async function proxyToGlm(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const upstream = await fetchImpl(
    buildUpstreamRequest(request, buildUpstreamUrl(new URL(request.url)), env.GLM_API_KEY),
  );
  return passthroughResponse(upstream);
}

/** nano files 列表响应:{ data, next_page },需适配成 GLM 的 ManagedFilePage 形状 */
interface NanoFilePage {
  data: { id?: string }[];
  next_page: string | null;
}

/**
 * files 列表的入参适配:console 的资源 ID 游标 after_id 映射为 nano 的
 * opaque page 游标;nano 不认识 before_id,一并丢弃(console 翻上一页靠游标历史,不发它)。
 */
function buildNanoFileListUrl(url: URL, nanoApiBase: string): URL {
  const upstream = buildNanoUpstreamUrl(url, nanoApiBase);
  const params = upstream.searchParams;
  const cursor = params.get('after_id');
  params.delete('after_id');
  params.delete('before_id');
  if (cursor !== null) params.set('page', cursor);
  return upstream;
}

/**
 * files 列表的响应适配成 GLM ManagedFilePage:
 * has_more ← next_page 非 null;last_id 透传 nano 的 next_page 游标——
 * console 把 last_id 仅当 opaque 翻页令牌用(file-list 拿它发下一次 after_id,
 * 入参适配再映射回 page),游标经浏览器无损往返;first_id 无消费者,按字面取首条 ID。
 */
async function adaptFileListResponse(upstream: Response): Promise<Response> {
  const passthrough = passthroughResponse(upstream);
  // 非 2xx 的错误信封原样透传,浏览器侧统一走 GLM 错误解析
  if (!upstream.ok) return passthrough;

  let page: NanoFilePage;
  try {
    page = (await passthrough.json()) as NanoFilePage;
  } catch {
    // nano 对 200 不会返回非 JSON;万一发生,按空页兜底,避免浏览器侧崩在解析上
    page = { data: [], next_page: null };
  }

  const headers = new Headers(passthrough.headers);
  headers.set('content-type', 'application/json');
  return new Response(
    JSON.stringify({
      data: page.data,
      has_more: page.next_page !== null,
      first_id: page.data[0]?.id ?? null,
      last_id: page.next_page,
    }),
    { status: passthrough.status, statusText: passthrough.statusText, headers },
  );
}

/**
 * nano 分支:浏览器侧仍发 GLM 形状的路径与参数,协议差异由这里消化——
 * 路径前缀改写、鉴权换成 NANO_API_KEY、不带 zai 协议头。
 * 唯一的 wire 差异点是 files 列表分页(资源 ID 游标 vs opaque page 游标),见上。
 */
export async function proxyToNano(
  request: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const isFileList =
    request.method === 'GET' && url.pathname === `${NANO_PROXY_PREFIX}${GLM_RESOURCE_PREFIX}/files`;
  const upstreamUrl = isFileList
    ? buildNanoFileListUrl(url, env.NANO_API_BASE)
    : buildNanoUpstreamUrl(url, env.NANO_API_BASE);
  const upstreamRequest = buildUpstreamRequest(request, upstreamUrl, env.NANO_API_KEY, false);
  // 生产经 Service Binding(wrangler.jsonc services → nano-api)直连 Worker:
  // 同账号 Worker 间的普通 fetch 会被 Cloudflare 拒绝(404 "error code: 1042"),
  // 绑定的 fetch 忽略 URL 主机、按绑定路由,上面的绝对 URL 只提供路径与查询串。
  // 本地 vite dev 不建立绑定,回退普通 fetch,仍按 NANO_API_BASE 连本地 api。
  const upstream = env.NANO_API_SERVICE
    ? await env.NANO_API_SERVICE.fetch(upstreamRequest)
    : await fetchImpl(upstreamRequest);
  return isFileList ? adaptFileListResponse(upstream) : passthroughResponse(upstream);
}
