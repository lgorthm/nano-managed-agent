/**
 * Agent 资源的两张表,设计见 docs/agent/schema.md:
 * - agents: Agent 级状态(当前版本指针、归档时间)
 * - agent_versions: 不可变的版本配置快照
 *
 * JSON 列存归一化后的形态(与 API 响应一致),类型由 @nano/shared 提供。
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { McpServer, NormalizedAgentToolset, SkillReference } from "@nano/shared";

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
