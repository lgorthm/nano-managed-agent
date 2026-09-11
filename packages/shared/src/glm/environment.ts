/**
 * Environment 资源类型。见 references/cloud-environment.md 与
 * references/api/{create-environment,list-environments,get-environment}.md、
 * {update-environment,archive-environment,delete-environment}.md。
 */
import type { ListQuery, Metadata, Page } from "./common";

/** 六个包管理器的预装声明;响应侧列表已由服务端排序去重 */
export interface EnvironmentPackages {
  type: "packages";
  apt: string[];
  cargo: string[];
  gem: string[];
  go: string[];
  npm: string[];
  pip: string[];
}

/** 网络策略 tagged union:unrestricted 自由出网;limited 仅放行 allowed_hosts */
export type EnvironmentNetworking =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowed_hosts: string[];
      allow_package_managers: boolean;
      allow_mcp_servers: boolean;
    };

/** 响应侧完整配置(规范化后):当前只支持 cloud 类型 */
export interface EnvironmentConfig {
  type: "cloud";
  packages: EnvironmentPackages;
  networking: EnvironmentNetworking;
}

export type EnvironmentState = "active" | "archived";

export interface Environment {
  id: string;
  type: "environment";
  name: string;
  description: string | null;
  metadata: Metadata;
  config: EnvironmentConfig;
  scope: "organization";
  state: EnvironmentState;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export type EnvironmentPage = Page<Environment>;

/** 输入侧包声明:六类均可省略或 null(视为空数组),服务端排序去重 */
export type EnvironmentPackagesInput = Partial<Record<keyof Omit<EnvironmentPackages, "type">, string[] | null>>;

/** 输入侧网络策略:limited 的三个字段均可省略(默认空列表 / false) */
export type EnvironmentNetworkingInput =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowed_hosts?: string[] | null;
      allow_package_managers?: boolean | null;
      allow_mcp_servers?: boolean | null;
    };

/** 输入侧配置;config 内出现未支持字段时服务端拒绝(400) */
export interface EnvironmentConfigInput {
  type: "cloud";
  packages?: EnvironmentPackagesInput | null;
  networking?: EnvironmentNetworkingInput | null;
}

export interface EnvironmentCreateInput {
  /** 长度 1–256 字符 */
  name: string;
  /** 用途说明;省略或 null 不设置 */
  description?: string | null;
  metadata?: Metadata;
  /** 省略或 null 时使用默认:cloud + 空 packages + unrestricted */
  config?: EnvironmentConfigInput | null;
}

/**
 * 更新是替换语义:config 整体替换(非深合并),name/description 省略时保持不变
 * (description 传 null 表示清空);metadata 键级合并。
 */
export interface EnvironmentUpdateInput {
  name?: string;
  description?: string | null;
  metadata?: Metadata;
  scope?: "organization";
  /** null 表示恢复默认 cloud 配置 */
  config?: EnvironmentConfigInput | null;
}

export interface EnvironmentDeleted {
  id: string;
  type: "environment_deleted";
}

export interface EnvironmentListQuery extends ListQuery {}
