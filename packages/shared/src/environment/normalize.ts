/**
 * 归一化:把允许大量省略的输入补全为完全展开的形态。
 * 输出同时是落库形态与 API 响应形态(见 docs/environment/schema.md 的"落库即归一化"原则):
 * - config 省略或 null 展开为 cloud + 空 packages + unrestricted
 * - packages 六类列表补全为空数组,重复项去重(保留首次出现顺序)
 * - limited 的 allowed_hosts 小写化、排序、去重;两个联网开关补为具体布尔值
 */
import type {
  EnvironmentConfigInput,
  EnvironmentCreateRequestInput,
  EnvironmentNetworkingInput,
  EnvironmentPackagesInput,
  PackageManager,
} from './schemas';
import { PACKAGE_MANAGERS } from './schemas';

/** 归一化后的包声明:六类键全部出现 */
export interface NormalizedEnvironmentPackages {
  type: 'packages';
  apt: string[];
  cargo: string[];
  gem: string[];
  go: string[];
  npm: string[];
  pip: string[];
}

/** 归一化后的网络策略:具体生效的形态,无 null / 省略 */
export type NormalizedEnvironmentNetworking =
  | { type: 'unrestricted' }
  | {
      type: 'limited';
      allowed_hosts: string[];
      allow_package_managers: boolean;
      allow_mcp_servers: boolean;
    };

export interface NormalizedEnvironmentConfig {
  type: 'cloud';
  packages: NormalizedEnvironmentPackages;
  networking: NormalizedEnvironmentNetworking;
}

/** 环境的可变当前态(单表无版本):name/description/config/metadata 的归一化载体 */
export interface NormalizedEnvironmentRecord {
  name: string;
  description: string | null;
  config: NormalizedEnvironmentConfig;
  metadata: Record<string, string>;
}

/** Environment 的 API 响应形状(docs/environment/api/create-environment.md 的 Environment) */
export interface EnvironmentResponse {
  id: string;
  type: 'environment';
  name: string;
  description: string | null;
  metadata: Record<string, string>;
  config: NormalizedEnvironmentConfig;
  scope: 'organization';
  state: 'active' | 'archived';
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 删除回执(docs/environment/api/delete-environment.md) */
export interface EnvironmentDeletedResponse {
  id: string;
  type: 'environment_deleted';
}

/** 默认 cloud 配置:空 packages + unrestricted 网络 */
export function defaultEnvironmentConfig(): NormalizedEnvironmentConfig {
  return {
    type: 'cloud',
    packages: normalizePackages(null),
    networking: { type: 'unrestricted' },
  };
}

/** 去重并保留首次出现顺序(GLM 仅声明去重,未声明排序) */
function dedupeKeepOrder(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function normalizePackages(
  input: EnvironmentPackagesInput | null | undefined,
): NormalizedEnvironmentPackages {
  const packages = { type: 'packages' } as NormalizedEnvironmentPackages;
  for (const manager of PACKAGE_MANAGERS) {
    packages[manager] = input ? dedupeKeepOrder(input[manager] ?? []) : [];
  }
  return packages;
}

function normalizeNetworking(
  input: EnvironmentNetworkingInput | null | undefined,
): NormalizedEnvironmentNetworking {
  if (!input || input.type === 'unrestricted') {
    return { type: 'unrestricted' };
  }
  return {
    type: 'limited',
    allowed_hosts: [
      ...new Set((input.allowed_hosts ?? []).map((host) => host.toLowerCase())),
    ].sort(),
    allow_package_managers: input.allow_package_managers ?? false,
    allow_mcp_servers: input.allow_mcp_servers ?? false,
  };
}

/** 配置输入归一化;null / undefined 展开为默认 cloud 配置(merge 也会复用) */
export function normalizeEnvironmentConfig(
  input: EnvironmentConfigInput | null | undefined,
): NormalizedEnvironmentConfig {
  if (!input) return defaultEnvironmentConfig();
  return {
    type: 'cloud',
    packages: normalizePackages(input.packages),
    networking: normalizeNetworking(input.networking),
  };
}

/** 把校验通过的创建请求归一化为落库形态 */
export function normalizeEnvironmentCreate(
  input: EnvironmentCreateRequestInput,
): NormalizedEnvironmentRecord {
  return {
    name: input.name,
    description: input.description ?? null,
    config: normalizeEnvironmentConfig(input.config),
    metadata: input.metadata,
  };
}

/** 逐包管理器遍历的辅助:归一化形态专用(schemas 的 PACKAGE_MANAGERS 同源) */
export function packageLists(
  config: NormalizedEnvironmentConfig,
): Array<[PackageManager, string[]]> {
  return PACKAGE_MANAGERS.map((manager) => [manager, config.packages[manager]] as const) as Array<
    [PackageManager, string[]]
  >;
}
