/**
 * Session 资源的协议层定义,以 docs/session/api/*.md 的 OpenAPI 为准。
 * 所有 schema 均 strict(拒绝未知键,对应 additionalProperties: false)。
 * 一期裁剪(initial_events / vault_ids 非空拒绝、resources 仅 file 类型)
 * 以 refine 分支实现,schema 主体与 GLM 形状一致,二期放开时删掉分支即可。
 */
import { z } from "zod";
import {
  AgentToolsetInputSchema,
  McpServerSchema,
  MetadataSchema,
  MetadataPatchSchema,
  ModelInputSchema,
  SkillReferenceSchema,
} from "../agent/schemas";
import type { SessionAgentConfig } from "./resolve";

// ---------- 状态与常量 ----------

export const SESSION_STATUSES = ["idle", "running", "rescheduling", "terminated"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** nano 一期没有运行时,会话创建后恒为 idle;running 门禁为二期就位预留 */
export const DEFAULT_SESSION_STATUS: SessionStatus = "idle";

export const SESSION_STATUSES_PARAM = "statuses[]";

/** 每会话 file 挂载上限(GLM 默认平台上限;resources 合计上限 508,一期只有 file) */
export const MAX_SESSION_FILE_RESOURCES = 500;
export const MAX_SESSION_RESOURCES = 508;

// ---------- 挂载资源 ----------

export const FileResourceInputSchema = z.strictObject({
  type: z.literal("file"),
  file_id: z.string().min(1),
  mount_path: z.string().nullish(),
});
export type FileResourceInput = z.infer<typeof FileResourceInputSchema>;

// ---------- Agent 引用(三种形态) ----------

/** 固定版本引用;省略 version 时钉创建请求时的当前版本 */
export const AgentReferenceInputSchema = z.strictObject({
  type: z.literal("agent"),
  id: z.string().min(1),
  version: z.number().int().min(1).optional(),
});

/** 会话级覆盖:每个字段整体替换,省略继承版本、null 与空数组清空 */
export const AgentWithOverridesInputSchema = z.strictObject({
  type: z.literal("agent_with_overrides"),
  id: z.string().min(1),
  version: z.number().int().min(1).optional(),
  model: ModelInputSchema.optional(),
  system: z.string().max(100000).nullish(),
  tools: z.array(AgentToolsetInputSchema).max(128).nullish(),
  skills: z.array(SkillReferenceSchema).max(20).nullish(),
  mcp_servers: z.array(McpServerSchema).max(20).nullish(),
});

/** Agent ID 字符串 / 固定版本引用 / 带覆盖的引用 */
export const SessionAgentInputSchema = z.union([
  z.string().min(1),
  AgentReferenceInputSchema,
  AgentWithOverridesInputSchema,
]);
export type SessionAgentInput = z.infer<typeof SessionAgentInputSchema>;

// ---------- 创建请求 ----------

/**
 * 创建 Session 的请求体。wire 上 agent 与兼容字段 agent_id 至少其一(anyOf);
 * 覆盖的跨字段约束(mcp 映射、skills 联动)作用于解析后的最终配置,由 service 在
 * resolveSessionAgent 之后用 agentConfigIssues 校验,不在请求层做。
 */
export const SessionCreateRequestSchema = z
  .strictObject({
    agent: SessionAgentInputSchema.optional(),
    agent_id: z.string().min(1).optional(),
    environment_id: z
      .string()
      .regex(
        /^env_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        "environment_id must be an env_ prefixed UUID",
      ),
    title: z.string().max(256).nullish(),
    metadata: MetadataSchema.default({}),
    initial_events: z.array(z.unknown()).max(50).default([]),
    resources: z.array(FileResourceInputSchema).max(MAX_SESSION_RESOURCES).default([]),
    vault_ids: z.array(z.string().min(1)).max(20).default([]),
  })
  .superRefine((request, ctx) => {
    if (request.agent === undefined && request.agent_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agent"],
        message: "either agent or the compatible field agent_id must be provided",
      });
    }
    // 一期裁剪:无事件存储,非空拒绝(GLM 形状保留,二期放开)
    if (request.initial_events.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["initial_events"],
        message: "initial_events is not supported yet: nano has no event storage in this phase",
      });
    }
    // 一期裁剪:无 Vault 资源,非空拒绝
    if (request.vault_ids.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["vault_ids"],
        message: "vault_ids is not supported yet: nano has no vault resources",
      });
    }
    // resources 合计 ≤ 508 由数组上限保证;file 单独 ≤ 500(一期只有 file,防御性保留)
    if (request.resources.length > MAX_SESSION_FILE_RESOURCES) {
      ctx.addIssue({
        code: "custom",
        path: ["resources"],
        message: `at most ${MAX_SESSION_FILE_RESOURCES} file resources per session`,
      });
    }
  });

export type SessionCreateRequestInput = z.output<typeof SessionCreateRequestSchema>;

// ---------- 更新请求 ----------

/**
 * 更新 Session 的请求体(docs/session/api/update-session.md):
 * - title/metadata 任意状态可更新;title 传 null 清空;metadata 按键合并(null 删键)
 * - agent 只允许 tools 与 mcp_servers 且至少其一;仅 idle 可更新(409 由 service 判定)
 * - model/system/skills/vault_ids/environment_id/resources 创建即冻结,
 *   strict 对象天然拒绝这些键(出现即 400)
 */
export const SessionUpdateRequestSchema = z
  .strictObject({
    title: z.string().max(256).nullish(),
    metadata: MetadataPatchSchema.nullish(),
    agent: z
      .strictObject({
        tools: z.array(AgentToolsetInputSchema).max(128).nullish(),
        mcp_servers: z.array(McpServerSchema).max(20).nullish(),
      })
      .superRefine((agent, ctx) => {
        if (agent.tools === undefined && agent.mcp_servers === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["agent"],
            message: "agent must provide tools or mcp_servers",
          });
        }
        const hasMcpToolset =
          agent.tools !== null && agent.tools !== undefined && agent.tools.some((t) => t.type === "mcp_toolset");
        if (hasMcpToolset && agent.mcp_servers === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["agent", "tools"],
            message: "submitting mcp_toolset requires replacing mcp_servers in the same request",
          });
        }
        if (agent.tools === undefined && agent.mcp_servers !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["agent", "mcp_servers"],
            message: "mcp_servers can only be submitted together with tools",
          });
        }
      })
      .optional(),
  })
  .superRefine((patch, ctx) => {
    if (patch.title === undefined && patch.metadata === undefined && patch.agent === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "request must provide at least one of title, metadata, agent",
      });
    }
  });

export type SessionUpdateRequestInput = z.output<typeof SessionUpdateRequestSchema>;

// ---------- 列表过滤 ----------

/** 时间边界为 epoch 毫秒,由传输层解析 RFC 3339 后传入 */
export interface SessionListFilters {
  agentId?: string;
  agentVersion?: number;
  statuses?: SessionStatus[];
  createdAtGt?: number;
  createdAtGte?: number;
  createdAtLt?: number;
  createdAtLte?: number;
  /** GLM Session 语义:默认排除已归档,include_archived=true 才包含 */
  includeArchived: boolean;
}

// ---------- 响应形状 ----------

export interface FileResourceResponse {
  id: string;
  type: "file";
  file_id: string;
  mount_path: string;
  created_at: string;
  updated_at: string;
}

/** wire 的 session.agent:固化的解析快照 + 注入的固定字段 */
export interface SessionAgentResponse extends SessionAgentConfig {
  id: string;
  type: "agent";
  multiagent: null;
  version: number;
}

/** Session 的 API 响应形状;vault_ids/outcome_evaluations/stats/budget 是一期固定回显 */
export interface SessionResponse {
  id: string;
  type: "session";
  agent: SessionAgentResponse;
  environment_id: string;
  status: SessionStatus;
  title: string | null;
  metadata: Record<string, string>;
  resources: FileResourceResponse[];
  vault_ids: string[];
  outcome_evaluations: Record<string, unknown>[];
  stats: { active_seconds: number; duration_seconds: number };
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
  budget: null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SessionDeletedResponse {
  id: string;
  type: "session_deleted";
}

export interface SessionResourceDeletedResponse {
  id: string;
  type: "session_resource_deleted";
}
