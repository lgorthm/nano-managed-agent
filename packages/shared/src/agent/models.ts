/**
 * 模型目录:模型 id(API/存储/UI 的稳定标识)到 Cloudflare AI Gateway
 * REST API wire 名称的映射,以及各模型的默认推理档位与来源分组。
 *
 * 模型调用统一经 api.cloudflare.com 的 /accounts/{id}/ai/v1/chat/completions
 * (OpenAI chat 格式,docs/session/runtime.md §1):
 * - 已知 id 优先查目录映射(存量 glm-5.3 / glm-5.3-flash 保持原 id 不变,
 *   wire 侧映射为 Cloudflare 托管的 @cf/zai-org 模型);
 * - 目录外的 id 视为动态模型:id 本身就是 wire 名称(如 /v1/models 从
 *   Workers AI Models API 动态拉取的 @cf/... 模型),原样透传上游。
 * 注:@cf/zai-org/* 不接受同服务 /ai/v1/responses 端点的 Responses 输入形状
 * (实测上游 400),模型输入统一走 chat completions。
 */
import type { ModelEffort } from "./schemas";

/** 模型来源:UI 分组展示用;workers-ai = Cloudflare 托管的 @cf 模型 */
export type ModelSource = "workers-ai" | "third-party";

export interface ModelCatalogEntry {
  /** 存储/API/UI 的稳定 id */
  id: string;
  /** UI 显示名 */
  label: string;
  /** 发往 /ai/v1/responses 的 model 字段 */
  wireModel: string;
  source: ModelSource;
  defaultEffort: ModelEffort;
}

/**
 * 静态目录基线(/v1/models 在此之上动态合并 Models API 的可用模型)。
 * 新增模型:加一条目录项即可;@cf/zai-org/glm-5.3 上线或映射调整时改 wireModel。
 */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: "glm-5.3",
    label: "glm-5.3",
    wireModel: "@cf/zai-org/glm-5.3",
    source: "workers-ai",
    defaultEffort: "max",
  },
  {
    id: "glm-5.3-flash",
    label: "glm-5.3-flash",
    wireModel: "@cf/zai-org/glm-5.3-flash",
    source: "workers-ai",
    defaultEffort: "high",
  },
];

export function findModelEntry(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((entry) => entry.id === id);
}

/** id → wire 名称:目录内映射,目录外原样透传(动态模型 id 即 wire 名) */
export function resolveWireModel(id: string): string {
  return findModelEntry(id)?.wireModel ?? id;
}

/** id → 默认推理档位:目录内按条目,目录外取通用档位 high */
export function defaultModelEffort(id: string): ModelEffort {
  return findModelEntry(id)?.defaultEffort ?? "high";
}

// ---------- /v1/models 的响应形状(console 创建 Agent 的可选模型来源) ----------

export interface ModelListEntry {
  id: string;
  label: string;
  wire_model: string;
  source: ModelSource;
  default_effort: ModelEffort;
}

export interface ModelListResponse {
  data: ModelListEntry[];
}

/** 目录条目 → 列表条目 */
export function catalogEntryToListEntry(entry: ModelCatalogEntry): ModelListEntry {
  return {
    id: entry.id,
    label: entry.label,
    wire_model: entry.wireModel,
    source: entry.source,
    default_effort: entry.defaultEffort,
  };
}

/** 动态拉取的模型名(如 @cf/zai-org/glm-5.2)→ 列表条目:id 即 wire 名 */
export function dynamicModelToListEntry(name: string): ModelListEntry {
  return {
    id: name,
    label: name,
    wire_model: name,
    source: name.startsWith("@cf/") ? "workers-ai" : "third-party",
    default_effort: defaultModelEffort(name),
  };
}

/** 静态目录 + 动态名称合并:按 wire 名称去重,静态目录已覆盖的(如经 glm-5.3
 *  条目映射的 @cf/zai-org/glm-5.3)不再以动态条目重复出现 */
export function mergeModelEntries(
  staticEntries: ModelListEntry[],
  dynamicNames: string[],
): ModelListEntry[] {
  const knownWireModels = new Set(staticEntries.map((entry) => entry.wire_model));
  return [
    ...staticEntries,
    ...dynamicNames.filter((name) => !knownWireModels.has(name)).map(dynamicModelToListEntry),
  ];
}
