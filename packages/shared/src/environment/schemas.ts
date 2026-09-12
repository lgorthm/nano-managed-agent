/**
 * Environment 资源的协议层定义,以 docs/environment/api/*.md 的 OpenAPI 为准。
 * 所有 schema 均 strict(拒绝未知键,对应 additionalProperties: false)——
 * config 内出现未支持的字段(含 self_hosted、自定义 registry 配置)一律 400。
 */
import { z } from "zod";
import { MetadataPatchSchema, MetadataSchema } from "../agent/schemas";

// ---------- 常量 ----------

/** 六类包管理器;声明顺序即服务端安装顺序(apt → cargo → gem → go → npm → pip) */
export const PACKAGE_MANAGERS = ["apt", "cargo", "gem", "go", "npm", "pip"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const MAX_PACKAGE_ITEMS = 200;
export const MAX_PACKAGE_ITEM_LENGTH = 256;
export const MAX_ALLOWED_HOSTS = 256;
export const MAX_HOST_LENGTH = 255;

// ---------- 包声明 ----------

/**
 * 包名:trim 后非空、不含空白或控制字符、不以 - 开头。
 * 自定义 registry / source / index URL 与私有源凭据配置不在协议内,未知键一律拒绝。
 */
const PackageNameSchema = z.string().min(1).max(MAX_PACKAGE_ITEM_LENGTH).superRefine((name, ctx) => {
  if (name.trim().length === 0) {
    ctx.addIssue({ code: "custom", message: "package name must not be empty or whitespace-only" });
  } else if (/[\s\u0000-\u001f\u007f]/.test(name)) {
    ctx.addIssue({ code: "custom", message: "package name must not contain whitespace or control characters" });
  }
  if (name.startsWith("-")) {
    ctx.addIssue({ code: "custom", message: "package name must not start with '-'" });
  }
});

const PackageListSchema = z.array(PackageNameSchema).max(MAX_PACKAGE_ITEMS).nullish();

/** 包声明;六类均可省略或 null,规范化为空数组 */
export const EnvironmentPackagesInputSchema = z.strictObject({
  type: z.literal("packages").optional(),
  apt: PackageListSchema,
  cargo: PackageListSchema,
  gem: PackageListSchema,
  go: PackageListSchema,
  npm: PackageListSchema,
  pip: PackageListSchema,
});
export type EnvironmentPackagesInput = z.infer<typeof EnvironmentPackagesInputSchema>;

// ---------- 网络策略 ----------

/**
 * hostname 或 *.example.com 通配;大小写不敏感(hostname 本身大小写无关,
 * 服务端归一化时统一小写化)。协议、端口、路径会引入 : / 字符,自然被拒绝;
 * 非 ASCII 主机名不做 punycode 转换,直接拒绝。
 */
const HOSTNAME_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const HostSchema = z.string().max(MAX_HOST_LENGTH).superRefine((host, ctx) => {
  if (!HOSTNAME_PATTERN.test(host)) {
    ctx.addIssue({
      code: "custom",
      message: `invalid host "${host}": expected a hostname or *.example.com wildcard without protocol, port, or path`,
    });
  }
});

/** 网络策略的二选一 tagged union;unrestricted 不得携带任何其他字段 */
export const EnvironmentNetworkingInputSchema = z.union([
  z.strictObject({
    type: z.literal("unrestricted"),
  }),
  z.strictObject({
    type: z.literal("limited"),
    allowed_hosts: z.array(HostSchema).max(MAX_ALLOWED_HOSTS).nullish(),
    allow_package_managers: z.boolean().nullish(),
    allow_mcp_servers: z.boolean().nullish(),
  }),
]);
export type EnvironmentNetworkingInput = z.infer<typeof EnvironmentNetworkingInputSchema>;

// ---------- 配置 ----------

/** 运行环境配置;省略或 null 时使用 cloud、空 packages、unrestricted networking */
export const EnvironmentConfigInputSchema = z.strictObject({
  type: z.literal("cloud"),
  packages: EnvironmentPackagesInputSchema.nullish(),
  networking: EnvironmentNetworkingInputSchema.nullish(),
});
export type EnvironmentConfigInput = z.infer<typeof EnvironmentConfigInputSchema>;

// ---------- 跨字段校验 ----------

/** 跨字段校验产出的问题描述 */
export interface EnvironmentConfigIssue {
  path: (string | number)[];
  message: string;
}

/**
 * 配置的跨字段规则,创建请求与更新后的合并结果共用(路径相对 config 根):
 * limited 网络下声明了 packages(六类任一非空)时,allow_package_managers 必须显式 true。
 * 对输入形态(undefined 视为 false)与归一化形态(已是具体布尔)同时成立。
 */
export function environmentConfigIssues(config: {
  packages?: Partial<Record<PackageManager, readonly string[] | null>> | null | undefined;
  networking?:
    | ({ type: "unrestricted" }
      | { type: "limited"; allow_package_managers?: boolean | null })
    | null
    | undefined;
}): EnvironmentConfigIssue[] {
  const issues: EnvironmentConfigIssue[] = [];
  const networking = config.networking;
  const hasPackages =
    config.packages !== null &&
    config.packages !== undefined &&
    PACKAGE_MANAGERS.some((manager) => (config.packages?.[manager]?.length ?? 0) > 0);
  if (networking?.type === "limited" && hasPackages && networking.allow_package_managers !== true) {
    issues.push({
      path: ["networking", "allow_package_managers"],
      message: 'networking "limited" with declared packages requires allow_package_managers to be true',
    });
  }
  return issues;
}

// ---------- 请求 schema ----------

/** 创建 Environment 的请求体 */
export const EnvironmentCreateRequestSchema = z
  .strictObject({
    name: z.string().min(1).max(256),
    description: z.string().max(1024).nullish(),
    metadata: MetadataSchema.default({}),
    scope: z.enum(["organization"]).nullish(),
    config: EnvironmentConfigInputSchema.nullish(),
  })
  .superRefine((request, ctx) => {
    if (request.config === null || request.config === undefined) return;
    for (const issue of environmentConfigIssues(request.config)) {
      ctx.addIssue({ code: "custom", path: ["config", ...issue.path], message: issue.message });
    }
  });

export type EnvironmentCreateRequestInput = z.output<typeof EnvironmentCreateRequestSchema>;

// ---------- 更新请求 ----------

/**
 * 更新 Environment 的请求体。语义(docs/environment/api/update-environment.md):
 * - 标量整体替换;description 传 null 清空,name 不可清空
 * - config 整体替换(非深合并);null 恢复默认 cloud 配置,省略保持不变
 * - metadata 按键合并,null 删键
 * - scope 只接受 organization,null 或省略不改变
 * - 无 version 字段:环境没有版本概念,更新是最后写入获胜,无 409
 * 空请求体({})是合法空补丁,由传输层归一。
 */
export const EnvironmentUpdateRequestSchema = z.strictObject({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).nullish(),
  metadata: MetadataPatchSchema.nullish(),
  scope: z.enum(["organization"]).nullish(),
  config: EnvironmentConfigInputSchema.nullish(),
});

export type EnvironmentUpdateRequestInput = z.output<typeof EnvironmentUpdateRequestSchema>;
