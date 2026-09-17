/**
 * Memory Store 与 Memory 类型。见 references/memory-stores.md 与
 * references/api/{create,list,get,update,delete,archive}-memory*.md。
 * Memory 以路径组织,平台为每次写入维护不可变的版本历史;
 * 列表项可能是 memory(条目)或 memory_prefix(目录前缀,树状浏览用)。
 */
import type { ListQuery, Metadata } from './common';

/** 元数据补丁:键值为 null 时删除对应键;整个字段省略时保持不变 */
export type MetadataPatch = Record<string, string | null>;

export interface MemoryStore {
  type: 'memory_store';
  id: string;
  name: string;
  description: string;
  metadata: Metadata;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryStoreListQuery extends ListQuery {
  include_archived?: boolean;
  'created_at[gte]'?: string;
  'created_at[lte]'?: string;
}

export interface MemoryStoreCreateInput {
  /** 1–255 个 Unicode 字符,不含控制/格式字符 */
  name: string;
  description?: string | null;
  metadata?: Metadata;
}

export interface MemoryStoreUpdateInput {
  /** null/省略 = 保持不变 */
  name?: string | null;
  /** null = 清空,省略 = 保持不变 */
  description?: string | null;
  metadata?: MetadataPatch;
}

export interface MemoryStoreDeleted {
  id: string;
  type: 'memory_store_deleted';
}

/** 列表项:条目或目录前缀(该前缀下没有直接条目时返回,用于树状浏览) */
export type MemoryListItem = Memory | MemoryPrefix;

export interface Memory {
  type: 'memory';
  id: string;
  memory_store_id: string;
  memory_version_id: string;
  path: string;
  content_sha256: string;
  content_size_bytes: number;
  /** 仅 view=full 时返回内容,否则为 null */
  content: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryPrefix {
  type: 'memory_prefix';
  path: string;
}

export interface MemoryListQuery extends ListQuery {
  /** 必须为 / 或以 / 结尾 */
  path_prefix?: string;
  /** 递归深度,0–1024 */
  depth?: number;
  /** full 时 limit 上限降到 20 */
  view?: 'basic' | 'full';
}

export interface MemoryCreateInput {
  /** NFC 路径,以 / 开头,不允许空、. 或 .. 路径段;UTF-8 最多 1024 字节 */
  path: string;
  /** UTF-8 内容,默认上限 102400 字节 */
  content: string;
}

export interface MemoryUpdateInput {
  path?: string | null;
  content?: string | null;
  /** 可选乐观锁:当前内容哈希不一致时拒绝更新 */
  precondition?: {
    type: 'content_sha256';
    content_sha256: string;
  };
}

/** 删除时的可选乐观锁;不匹配时拒绝删除 */
export interface MemoryDeleteQuery {
  expected_content_sha256?: string;
}

export interface MemoryDeleted {
  id: string;
  type: 'memory_deleted';
}

/** 版本的操作者:会话(代理写入)或控制台用户 */
export type MemoryActor =
  | { type: 'session_actor'; session_id: string }
  | { type: 'user_actor'; user_id: string };

export interface MemoryVersion {
  type: 'memory_version';
  id: string;
  memory_store_id: string;
  memory_id: string;
  operation: 'created' | 'modified' | 'deleted';
  path: string | null;
  content_sha256: string | null;
  content_size_bytes: number | null;
  /** 仅 view=full 且未脱敏/未删除时返回内容 */
  content: string | null;
  created_by: MemoryActor;
  redacted_at: string | null;
  redacted_by?: MemoryActor;
  created_at: string;
}

export interface MemoryVersionListQuery extends ListQuery {
  memory_id?: string;
  operation?: MemoryVersion['operation'];
  view?: 'basic' | 'full';
  'created_at[gte]'?: string;
  'created_at[lte]'?: string;
}

/** 脱敏:清空版本的 path/content/content_sha256,不可逆;无请求体 */
export type MemoryVersionRedactResponse = MemoryVersion;
