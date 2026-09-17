import type {
  Memory,
  MemoryCreateInput,
  MemoryDeleted,
  MemoryDeleteQuery,
  MemoryListItem,
  MemoryListQuery,
  MemoryStore,
  MemoryStoreCreateInput,
  MemoryStoreDeleted,
  MemoryStoreListQuery,
  MemoryStoreUpdateInput,
  MemoryUpdateInput,
  MemoryVersion,
  MemoryVersionListQuery,
  MemoryVersionRedactResponse,
} from '@nano/shared/glm';
import { glmFetch, glmFetchPage, qs } from './client';

const BASE = '/agent/managed/v1/memory_stores';

export function listMemoryStores(query: MemoryStoreListQuery = {}) {
  return glmFetchPage<MemoryStore>(BASE, query);
}

export function getMemoryStore(storeId: string) {
  return glmFetch<MemoryStore>(`${BASE}/${storeId}`);
}

export function createMemoryStore(input: MemoryStoreCreateInput) {
  return glmFetch<MemoryStore>(BASE, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** name/description 传 null 表示清空;metadata 为键级补丁(值为 null 删除键) */
export function updateMemoryStore(storeId: string, input: MemoryStoreUpdateInput) {
  return glmFetch<MemoryStore>(`${BASE}/${storeId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 归档后不能再挂到新会话;已挂载的会话在下一次访问时失败 */
export function archiveMemoryStore(storeId: string) {
  return glmFetch<MemoryStore>(`${BASE}/${storeId}/archive`, {
    method: 'POST',
  });
}

/** 级联删除 store 内全部 memory 与版本历史 */
export function deleteMemoryStore(storeId: string) {
  return glmFetch<MemoryStoreDeleted>(`${BASE}/${storeId}`, {
    method: 'DELETE',
  });
}

/** 条目列表可能混含 memory_prefix(目录前缀);view=full 时 limit 上限降到 20 */
export function listMemories(storeId: string, query: MemoryListQuery = {}) {
  return glmFetchPage<MemoryListItem>(`${BASE}/${storeId}/memories`, query);
}

export function createMemory(storeId: string, input: MemoryCreateInput) {
  return glmFetch<Memory>(`${BASE}/${storeId}/memories`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getMemory(storeId: string, memoryId: string) {
  return glmFetch<Memory>(`${BASE}/${storeId}/memories/${memoryId}`);
}

/** 带 precondition.content_sha256 时做乐观锁校验 */
export function updateMemory(storeId: string, memoryId: string, input: MemoryUpdateInput) {
  return glmFetch<Memory>(`${BASE}/${storeId}/memories/${memoryId}`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deleteMemory(storeId: string, memoryId: string, query: MemoryDeleteQuery = {}) {
  return glmFetch<MemoryDeleted>(`${BASE}/${storeId}/memories/${memoryId}${qs(query)}`, {
    method: 'DELETE',
  });
}

/** 不可变的版本审计流水;可按 memory_id / operation 过滤 */
export function listMemoryVersions(storeId: string, query: MemoryVersionListQuery = {}) {
  return glmFetchPage<MemoryVersion>(`${BASE}/${storeId}/memory_versions`, query);
}

export function getMemoryVersion(storeId: string, versionId: string) {
  return glmFetch<MemoryVersion>(`${BASE}/${storeId}/memory_versions/${versionId}`);
}

/** 脱敏指定版本(清空内容),不可逆;无请求体 */
export function redactMemoryVersion(storeId: string, versionId: string) {
  return glmFetch<MemoryVersionRedactResponse>(
    `${BASE}/${storeId}/memory_versions/${versionId}/redact`,
    { method: 'POST' },
  );
}
