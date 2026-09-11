/**
 * Session 与事件流类型。见 references/create-session.md、references/events.md
 * 与 references/api/{list-events,send-events,subscribe-events}.md。
 */
import type { ListQuery, Metadata } from "./common";
import type {
  McpServer,
  ModelResponse,
  SkillReference,
  ToolsetInput,
  ToolsetResponse,
} from "./agent";

export type SessionStatus = "idle" | "running" | "rescheduling" | "terminated";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    data: string;
  };
}

export interface DocumentBlock {
  type: "document";
  source:
    | { type: "text"; text: string }
    | { type: "file"; file_id: string };
  title?: string | null;
  context?: string | null;
}

export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

export interface UserMessageEventInput {
  type: "user.message";
  /** 1–20 个 block;普通事件允许文本、base64 图片或文档 */
  content: ContentBlock[];
}

/** 可提交的输入事件(骨架只覆盖 console 用得到的形态) */
export type EventInput =
  | UserMessageEventInput
  | { type: "user.interrupt" }
  | {
      type: "user.tool_confirmation";
      tool_use_id: string;
      result: "allow" | "deny";
      deny_message?: string | null;
    };

/** 会话/部署创建时的初始用户消息,仅允许文本与 base64 图片 */
export interface InitialUserMessageEventInput {
  type: "user.message";
  content: Array<TextBlock | ImageBlock>;
}

/** 持久化事件:其余字段由 type 对应的载荷决定 */
export interface PersistedEvent {
  id: string;
  type: EventType;
  /** 排队中的输入事件可能省略;部分确认/中断事件为 null */
  processed_at?: string | null;
  [key: string]: unknown;
}

/** SSE 实时事件(SSE data 的 JSON 与持久化事件同构,以 unknown 载荷呈现) */
export type StreamEvent = PersistedEvent | (Record<string, unknown> & { type?: string });

export type EventType =
  | "agent.custom_tool_use"
  | "agent.mcp_tool_result"
  | "agent.mcp_tool_use"
  | "agent.message"
  | "agent.thinking"
  | "agent.thread_context_compacted"
  | "agent.thread_message_received"
  | "agent.thread_message_sent"
  | "agent.tool_result"
  | "agent.tool_use"
  | "session.deleted"
  | "session.error"
  | "session.status_idle"
  | "session.status_rescheduled"
  | "session.status_running"
  | "session.status_terminated"
  | "session.thread_created"
  | "session.thread_status_idle"
  | "session.thread_status_rescheduled"
  | "session.thread_status_running"
  | "session.thread_status_terminated"
  | "session.updated"
  | "session.usage"
  | "span.model_request_end"
  | "span.model_request_start"
  | "span.outcome_evaluation_end"
  | "span.outcome_evaluation_ongoing"
  | "span.outcome_evaluation_start"
  | "system.message"
  | "user.custom_tool_result"
  | "user.define_outcome"
  | "user.interrupt"
  | "user.message"
  | "user.tool_confirmation"
  | "user.tool_result";

export interface SessionAgent {
  id: string;
  type: "agent";
  name: string;
  model: ModelResponse;
  system: string | null;
  description: string | null;
  tools: ToolsetResponse[];
  skills: SkillReference[];
  mcp_servers: McpServer[];
  version: number;
}

export interface SessionResource {
  type: "memory_store" | "file";
  memory_store_id?: string;
  access?: "read_only" | "read_write";
  instructions?: string | null;
  file_id?: string;
  mount_path?: string | null;
}

/** 已挂载的文件资源(响应侧,平台分配 id;移除挂载用) */
export interface SessionFileResource {
  type: "file";
  id: string;
  file_id: string;
  mount_path: string;
  created_at: string;
  updated_at: string;
}

/** 已挂载的 memory store 资源:无独立 id,以 memory_store_id 标识,不可单独移除 */
export interface SessionMemoryStoreResource {
  type: "memory_store";
  memory_store_id: string;
  name: string;
  description: string | null;
  access: "read_only" | "read_write";
  instructions: string | null;
  mount_path: string;
}

export type SessionResourceResponse = SessionFileResource | SessionMemoryStoreResource;

/** 挂载新文件;mount_path 省略时默认 /mnt/session/uploads/{file_id},不能逃逸该目录 */
export interface SessionFileResourceInput {
  type: "file";
  file_id: string;
  mount_path?: string | null;
}

export interface SessionResourceDeleted {
  id: string;
  type: "session_resource_deleted";
}

export interface Session {
  id: string;
  type: "session";
  agent: SessionAgent;
  environment_id: string;
  status: SessionStatus;
  title: string | null;
  metadata: Metadata;
  resources: SessionResource[];
  vault_ids: string[];
  outcome_evaluations: Array<Record<string, unknown>>;
  stats: {
    active_seconds: number;
    duration_seconds: number;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
  budget: null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** Agent 引用:固定 ID、固定版本,或带会话级配置覆盖 */
export type SessionAgentInput =
  | string
  | { type: "agent"; id: string; version?: number }
  | {
      type: "agent_with_overrides";
      id: string;
      version?: number;
      model?: import("./agent").ModelInput;
      system?: string | null;
      tools?: ToolsetInput[] | null;
      skills?: SkillReference[] | null;
      mcp_servers?: McpServer[] | null;
    };

export interface SessionCreateInput {
  agent: SessionAgentInput;
  environment_id: string;
  title?: string | null;
  metadata?: Metadata;
  initial_events?: InitialUserMessageEventInput[];
  resources?: SessionResource[];
  vault_ids?: string[];
}

export interface SessionUpdateInput {
  title?: string | null;
  metadata?: Metadata;
}

export interface SessionEventListQuery extends ListQuery {
  /** 事件类型过滤,可多个 */
  types?: string[];
  "created_at[gt]"?: string;
  "created_at[gte]"?: string;
  "created_at[lt]"?: string;
  "created_at[lte]"?: string;
}

export interface SendEventsInput {
  /** 一次提交 1–10 个事件,按数组顺序处理 */
  events: EventInput[];
}
