import { useSyncExternalStore } from "react";

/**
 * 后端选择:console 同时支持 GLM 与 nano 两套 Managed Agents API,
 * 由 sidebar 底部的 Select 切换。模块级 store 同步供 client.ts 取代理前缀,
 * React 侧经 useProvider 订阅;选择持久化在 localStorage,缺省 nano。
 */
export type ApiProvider = "glm" | "nano";

const STORAGE_KEY = "nano-console:provider";
const DEFAULT_PROVIDER: ApiProvider = "nano";

const PROVIDERS: readonly ApiProvider[] = ["glm", "nano"];

let current: ApiProvider = readStored();
const listeners = new Set<() => void>();

function readStored(): ApiProvider {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return PROVIDERS.includes(raw as ApiProvider) ? (raw as ApiProvider) : DEFAULT_PROVIDER;
  } catch {
    // localStorage 不可用(隐私模式等)时退回缺省值,仅内存态生效
    return DEFAULT_PROVIDER;
  }
}

export function getProvider(): ApiProvider {
  return current;
}

/** 切换后端并持久化;调用方负责清 React Query 缓存(query key 无 provider 维度) */
export function setProvider(provider: ApiProvider): void {
  if (provider === current) return;
  current = provider;
  try {
    localStorage.setItem(STORAGE_KEY, provider);
  } catch {
    // 写不进去就只保内存态
  }
  for (const notify of listeners) notify();
}

export function useProvider(): ApiProvider {
  return useSyncExternalStore(subscribe, getProvider);
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}
