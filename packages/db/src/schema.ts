/**
 * Agent 资源的两张表,设计见 docs/agent/schema.md:
 * - agents: Agent 级状态(当前版本指针、归档时间)
 * - agent_versions: 不可变的版本配置快照
 *
 * Skill 资源的三张表,设计见 docs/skills/schema.md:
 * - skills: Skill 级状态(最新版本指针、版本号分配器)
 * - skill_versions: 不可变的目录快照(frontmatter 元数据)
 * - skill_files: 不可变的目录快照(规范树文件内容)
 *
 * File 资源的一张表,设计见 docs/files/schema.md:
 * - files: 元数据(内容在 R2,对象键恒为 files/{id},由 id 派生不落库)
 *
 * Environment 资源的一张表,设计见 docs/environment/schema.md:
 * - environments: 单表当前态(无版本快照,config 以归一化形态存储)
 *
 * JSON 列存归一化后的形态(与 API 响应一致),类型由 @nano/shared 提供。
 */
import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  McpServer,
  NormalizedAgentToolset,
  NormalizedEnvironmentConfig,
  SkillReference,
} from "@nano/shared";

/** BLOB ↔ Uint8Array:D1 的绑定参数与返回值原生使用二进制形态 */
const uint8Blob = customType<{ data: Uint8Array; driverData: ArrayBuffer }>({
  dataType: () => "blob",
  fromDriver: (value) => new Uint8Array(value),
});

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(), // agent_ + UUIDv7
    currentVersion: integer("current_version").notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_agents_created_at_id").on(t.createdAt, t.id)],
);

export const agentVersions = sqliteTable(
  "agent_versions",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    system: text("system"),
    modelId: text("model_id").notNull(),
    modelEffort: text("model_effort").notNull(),
    modelSpeed: text("model_speed").notNull(),
    tools: text("tools", { mode: "json" })
      .$type<NormalizedAgentToolset[]>()
      .notNull()
      .default(sql`'[]'`),
    skills: text("skills", { mode: "json" })
      .$type<SkillReference[]>()
      .notNull()
      .default(sql`'[]'`),
    mcpServers: text("mcp_servers", { mode: "json" })
      .$type<McpServer[]>()
      .notNull()
      .default(sql`'[]'`),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.version] })],
);

/** Skill 级状态:身份、展示名、最新版本指针、版本号分配器 */
export const skills = sqliteTable(
  "skills",
  {
    id: text("id").primaryKey(), // skill_ + UUIDv7
    displayTitle: text("display_title"),
    source: text("source").notNull().default("custom"), // nano 单租户恒为 custom,保留列对齐 wire-format
    latestVersionSeq: integer("latest_version_seq"), // NULL = 空壳(所有版本已删)
    nextVersion: integer("next_version").notNull(), // 版本号分配器,只增不减、删除不复用
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_skills_created_at_id").on(t.createdAt, t.id)],
);

/** 版本级目录快照(元数据):frontmatter 解析结果与统计;写入后不可变 */
export const skillVersions = sqliteTable(
  "skill_versions",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    version: integer("version").notNull(),
    id: text("id").notNull(), // skv_ + UUIDv7,响应回显用;寻址一律用 (skill_id, version)
    name: text("name").notNull(),
    description: text("description").notNull(),
    directory: text("directory").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.version] }),
    uniqueIndex("idx_skill_versions_id").on(t.id),
  ],
);

/** 版本级目录快照(内容):规范树,与版本行同 batch 写入、同 batch 删除 */
export const skillFiles = sqliteTable(
  "skill_files",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id),
    version: integer("version").notNull(),
    path: text("path").notNull(),
    content: uint8Blob("content").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.version, t.path] })],
);

/**
 * File 元数据;内容在 R2(对象键恒为 files/{id},由 id 派生不落库)。
 * 行存在 ⇔ 内容可读(由上传/删除顺序保证,见 docs/files/schema.md);
 * 写入后不可变,删除是唯一生命周期变更。
 */
export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(), // file_ + UUIDv7
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    etag: text("etag").notNull(), // R2 put 返回的对象 ETag,下载时回显
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_files_created_at_id").on(t.createdAt, t.id)],
);

/**
 * Environment 单表当前态:无版本快照(GLM 的 Environment 无 version 字段,
 * 快照固化发生在 Session 侧),更新是就地覆盖。
 * 不变式:archived_at IS NULL ⟺ state = 'active';
 * type/scope 是响应固定字段,不落库,序列化时注入。
 */
export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(), // env_ + UUIDv7
    name: text("name").notNull(),
    description: text("description"),
    config: text("config", { mode: "json" }).$type<NormalizedEnvironmentConfig>().notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'`),
    state: text("state")
      .$type<"active" | "archived">()
      .notNull()
      .default("active"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("idx_environments_created_at_id").on(t.createdAt, t.id)],
);
