/**
 * Workers AI Models API 的动态模型目录拉取(GET /accounts/{id}/ai/models/search)。
 * AI Gateway 没有「列出网关内模型」的统一接口(cloudflare/ai#549 请求中),
 * /v1/models 以静态目录为基线,配置了凭据时在此之上合并线上目录;上游失败
 * 静默降级为仅静态目录(模型列表不构成可用性依赖)。
 */
import type { Env } from "../../env";

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Models API 条目的断言形状(开放信封,只取用到的字段) */
interface ModelsSearchEntry {
  name?: string;
}

/** isolate 内缓存:同一实例的并发与近期请求共享一次上游拉取 */
let cache: { value: string[]; expiresAt: number } | null = null;

/** 拉取 Text Generation 类模型的 name 列表;失败返回 null(调用方降级)。fetch 可注入(测试) */
export async function fetchDynamicModelNames(
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  const now = Date.now();
  if (cache !== null && cache.expiresAt > now) return cache.value;
  if (env.CLOUDFLARE_ACCOUNT_ID === undefined || env.CLOUDFLARE_API_TOKEN === undefined) return null;
  try {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?task=${encodeURIComponent("Text Generation")}&per_page=100`,
      { headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { result?: ModelsSearchEntry[] };
    const names = (payload.result ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string" && name !== "");
    cache = { value: names, expiresAt: now + MODELS_CACHE_TTL_MS };
    return names;
  } catch {
    return null; // 网络/解析失败:降级,不打断列表接口
  }
}

/** 测试专用:清空 isolate 内缓存(时间推进类断言与用例隔离用) */
export function resetDynamicModelsCache(): void {
  cache = null;
}
