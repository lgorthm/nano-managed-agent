import type { GlmErrorBody, Page } from "@nano/shared/glm";

/**
 * 浏览器侧 GLM client:统一打同域 /glm 代理,不携带任何鉴权头——
 * Access cookie 由平台自动带上,worker 校验 JWT 后注入 GLM API Key。
 */
const GLM_PROXY_BASE = "/glm";

export class GlmApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "GlmApiError";
  }
}

export type QueryValue = string | number | boolean | string[] | undefined;
export type QueryParams = Record<string, QueryValue>;

/** 接受任意形状的查询对象(shared 里的 ListQuery 等 interface 没有隐式索引签名) */
export function qs(params: object = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
    else search.set(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

/** 非 2xx 响应统一解析 GLM 错误信封后抛出;解析失败(如 Access 拦截页)保留兜底信息 */
async function throwIfError(res: Response): Promise<void> {
  if (res.ok) return;
  let type = `http_${res.status}`;
  let message = `请求失败(HTTP ${res.status})`;
  try {
    const body = (await res.json()) as {
      error?: { type?: string; message?: string };
    };
    if (body.error?.message) {
      type = body.error.type ?? type;
      message = body.error.message;
    }
  } catch {
    // 非 JSON 错误体(如 Access 拦截页),保留默认信息
  }
  throw new GlmApiError(res.status, type, message);
}

export async function glmFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GLM_PROXY_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      // FormData 的 multipart boundary 由浏览器生成,不能手动指定 content-type
      ...(init?.body != null && !(init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...init?.headers,
    },
  });
  await throwIfError(res);

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 同 glmFetch 的错误处理,但返回原始 Response——ZIP 下载等二进制响应用 */
export async function glmFetchRaw(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${GLM_PROXY_BASE}${path}`, { ...init, headers: init?.headers });
  await throwIfError(res);
  return res;
}

export function glmFetchPage<T>(path: string, params: object = {}): Promise<Page<T>> {
  return glmFetch<Page<T>>(`${path}${qs(params)}`);
}

/** 从 content-disposition 解析文件名;支持 RFC 5987 扩展写法,缺失时返回 null */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (extended) return decodeURIComponent(extended[1]?.replace(/^"|"$/g, "").trim() ?? "");
  const plain = /filename=("?)([^";]+)\1/i.exec(header);
  return plain ? (plain[2] ?? null) : null;
}

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/**
 * 手工订阅 text/event-stream。不用原生 EventSource:
 * 它无法参与统一的错误处理,且我们需要 AbortSignal 控制断开。
 */
export async function subscribeGlmStream(
  path: string,
  onMessage: (msg: SseMessage) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${GLM_PROXY_BASE}${path}`, {
    signal,
    headers: { accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    throw new GlmApiError(res.status, "stream_error", `事件流连接失败(HTTP ${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      emitMessage(chunk, onMessage);
      sep = buffer.indexOf("\n\n");
    }
  }
}

function emitMessage(chunk: string, onMessage: (msg: SseMessage) => void): void {
  const msg: SseMessage = { data: "" };
  for (const line of chunk.split("\n")) {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") msg.data = msg.data ? `${msg.data}\n${value}` : value;
    else if (field === "event") msg.event = value;
    else if (field === "id") msg.id = value;
  }
  if (msg.data || msg.event) onMessage(msg);
}
