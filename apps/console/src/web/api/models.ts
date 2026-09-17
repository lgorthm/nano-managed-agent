import type { ModelEffort, ModelListEntry, ModelListResponse } from '@nano/shared';
import { useQuery } from '@tanstack/react-query';
import { useProvider } from '@/lib/provider';
import { glmFetch } from './client';

/** 模型条目的 UI 形态(console 下拉直接消费) */
export interface ModelOption {
  id: string;
  label: string;
  defaultEffort: ModelEffort;
  source?: ModelListEntry['source'];
}

/** provider=glm 时的回退清单:上游 GLM 平台没有模型目录端点,只认识这两个 */
export const GLM_PROVIDER_MODELS: ModelOption[] = [
  { id: 'glm-5.3', label: 'glm-5.3', defaultEffort: 'max' },
  { id: 'glm-5.3-flash', label: 'glm-5.3-flash', defaultEffort: 'high' },
];

/** nano provider 经 /nano 代理到 nano-api 的 GET /v1/models(静态目录 + Workers AI 动态合并) */
export function listModels() {
  return glmFetch<ModelListResponse>('/agent/managed/v1/models');
}

// ---------- 下拉分组渲染 ----------

export interface ModelOptionGroup {
  /** null = 无 source 的平铺条目(provider=glm 回退清单) */
  label: string | null;
  options: ModelOption[];
}

const SOURCE_GROUP_LABELS: Record<string, string> = {
  'workers-ai': 'Workers AI(Cloudflare 托管,经 AI Gateway)',
  'third-party': '第三方模型(Unified Billing)',
};

/** 按 source 分组并保持首现顺序;无 source 的条目归入平铺组排在最前 */
export function groupedModelOptions(options: ModelOption[]): ModelOptionGroup[] {
  const groups = new Map<string, ModelOptionGroup>();
  const flat: ModelOptionGroup = { label: null, options: [] };
  for (const option of options) {
    if (option.source === undefined) {
      flat.options.push(option);
      continue;
    }
    const label = SOURCE_GROUP_LABELS[option.source] ?? option.source;
    const group = groups.get(option.source) ?? { label, options: [] };
    group.options.push(option);
    groups.set(option.source, group);
  }
  return [flat, ...groups.values()].filter((group) => group.options.length > 0);
}

/**
 * 当前 provider 的可选模型。nano = nano-api 的模型目录(创建 Agent 可选
 * AI Gateway 里的模型);glm = GLM 平台仅有的两个模型。列表拉取失败时回退
 * GLM 清单,创建入口不至于不可用。
 */
export function useModelOptions(): {
  options: ModelOption[];
  isLoading: boolean;
} {
  const provider = useProvider();
  const query = useQuery({
    queryKey: ['models', provider],
    queryFn: async () => {
      if (provider !== 'nano') return GLM_PROVIDER_MODELS;
      try {
        const body = await listModels();
        return body.data.map(
          (entry): ModelOption => ({
            id: entry.id,
            label: entry.label,
            defaultEffort: entry.default_effort,
            source: entry.source,
          }),
        );
      } catch {
        return GLM_PROVIDER_MODELS;
      }
    },
    staleTime: 5 * 60_000,
  });
  return {
    options: query.data ?? GLM_PROVIDER_MODELS,
    isLoading: query.isLoading,
  };
}
