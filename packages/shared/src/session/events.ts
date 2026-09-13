/**
 * 事件协议层定义,以 docs/session/runtime.md §2 与 GLM Managed Agents 的
 * list/send/subscribe-events OpenAPI(references/api/)为准。
 * wire 枚举保留 GLM 全集;二期运行时实际产生的子集见 PRODUCED_EVENT_TYPES,
 * 其余类型协议在、运行时不产生。
 */
import { z } from "zod";

// ---------- 事件类型全集与二期子集 ----------

/** GLM ManagedSessionEventTypes 全集(35 项);枚举永不收窄,新类型只能追加 */
export const EVENT_TYPES = [
  "agent.custom_tool_use",
  "agent.mcp_tool_result",
  "agent.mcp_tool_use",
  "agent.message",
  "agent.thinking",
  "agent.thread_context_compacted",
  "agent.thread_message_received",
  "agent.thread_message_sent",
  "agent.tool_result",
  "agent.tool_use",
  "session.deleted",
  "session.error",
  "session.status_idle",
  "session.status_rescheduled",
  "session.status_running",
  "session.status_terminated",
  "session.thread_created",
  "session.thread_status_idle",
  "session.thread_status_rescheduled",
  "session.thread_status_running",
  "session.thread_status_terminated",
  "session.updated",
  "session.usage",
  "span.model_request_end",
  "span.model_request_start",
  "span.outcome_evaluation_end",
  "span.outcome_evaluation_ongoing",
  "span.outcome_evaluation_start",
  "system.message",
  "user.custom_tool_result",
  "user.define_outcome",
  "user.interrupt",
  "user.message",
  "user.tool_confirmation",
  "user.tool_result",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 二期运行时产生的 14 个类型(runtime.md §2.3) */
export const PRODUCED_EVENT_TYPES = [
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "agent.thinking",
  "agent.message",
  "agent.tool_use",
  "agent.tool_result",
  "session.status_running",
  "session.status_idle",
  "session.error",
  "session.usage",
  "session.updated",
  "session.deleted",
  "system.message",
] as const;

/** session.status_idle 携带的停机原因;客户端只消费事件流即可还原状态机 */
export const STOP_REASON_TYPES = ["end_turn", "requires_action", "interrupted"] as const;
export type StopReasonType = (typeof STOP_REASON_TYPES)[number];

export interface StopReason {
  type: StopReasonType;
  /** 仅 requires_action:待审批的 agent.tool_use 事件 id 列表 */
  event_ids?: string[];
}

// ---------- 内容块(user.message 的 content;Anthropic 风格) ----------

export const TextBlockSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string().min(1),
});

export const ImageBlockSchema = z.strictObject({
  type: z.literal("image"),
  source: z.strictObject({
    type: z.literal("base64"),
    media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: z.string().min(1),
  }),
});

export const DocumentBlockSchema = z.strictObject({
  type: z.literal("document"),
  source: z.union([
    z.strictObject({
      type: z.literal("text"),
      media_type: z.literal("text/plain"),
      data: z.string(),
    }),
    z.strictObject({ type: z.literal("file"), file_id: z.string().min(1) }),
  ]),
  title: z.string().nullish(),
  context: z.string().nullish(),
});

export const ContentBlockSchema = z.union([TextBlockSchema, ImageBlockSchema, DocumentBlockSchema]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// ---------- 输入事件(send-events;一期已实现三种) ----------

export const UserMessageEventSchema = z.strictObject({
  type: z.literal("user.message"),
  content: z.array(ContentBlockSchema).min(1).max(20),
});

export const UserInterruptEventSchema = z.strictObject({ type: z.literal("user.interrupt") });

export const UserToolConfirmationEventSchema = z
  .strictObject({
    type: z.literal("user.tool_confirmation"),
    tool_use_id: z.string().min(1),
    result: z.enum(["allow", "deny"]),
    deny_message: z.string().nullish(),
  })
  .superRefine((event, ctx) => {
    if (event.result === "allow" && event.deny_message != null) {
      ctx.addIssue({
        code: "custom",
        path: ["deny_message"],
        message: "deny_message can only be provided when result is deny",
      });
    }
  });

/** send-events 可提交的输入事件 */
export const EventInputSchema = z.union([
  UserMessageEventSchema,
  UserInterruptEventSchema,
  UserToolConfirmationEventSchema,
]);
export type EventInput = z.infer<typeof EventInputSchema>;

/** 一次 send-events 请求的事件数上限(GLM:1–10,按数组顺序处理) */
export const MAX_EVENTS_PER_REQUEST = 10;

export const SendEventsRequestSchema = z.strictObject({
  events: z.array(EventInputSchema).min(1).max(MAX_EVENTS_PER_REQUEST),
});
export type SendEventsRequestInput = z.infer<typeof SendEventsRequestSchema>;

/** 创建 / Deployment 的 initial_events:仅 user.message,content 不允许 document 块(GLM 语义) */
export const InitialUserMessageEventSchema = z.strictObject({
  type: z.literal("user.message"),
  content: z.array(z.union([TextBlockSchema, ImageBlockSchema])).min(1).max(20),
});
export type InitialUserMessageEventInput = z.infer<typeof InitialUserMessageEventSchema>;

// ---------- 持久化事件与流帧 ----------

/** JSON 载荷值;受限集合保证跨 DO RPC 边界的结构化克隆类型安全 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 持久化事件信封:载荷字段按 type 展开在顶层(同 GLM additionalProperties: true)。
 * processed_at 是唯一可变字段——排队中的输入事件为 null,消费后回填(runtime.md §2.1)。
 */
export interface PersistedEventJson {
  id: string;
  type: EventType;
  created_at: string;
  processed_at?: string | null;
  [key: string]: JsonValue;
}

/** 存在 delta 增量的产出事件类型;event_deltas[] 订阅参数的可选值 */
export const DELTA_EVENT_TYPES = ["agent.message", "agent.thinking"] as const;
export type DeltaEventType = (typeof DELTA_EVENT_TYPES)[number];

/** SSE 流上独有的增量帧(runtime.md §7):不落库,以 event_id 引用终事件 */
export interface DeltaFrame {
  type: `${DeltaEventType}.delta`;
  event_id: string;
  seq: number;
  delta: { text: string };
}

/** SSE data 帧的 JSON:持久化事件同构,或流上独有的 delta 帧 */
export type StreamFrame = PersistedEventJson | DeltaFrame;

// ---------- M0 产生的事件载荷形状(nano 定义;信封字段之外的顶层载荷) ----------

export interface UserMessagePayload {
  content: ContentBlock[];
}

export interface StatusIdlePayload {
  stop_reason: StopReason;
}

export interface UsagePayload {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

export interface SystemMessagePayload {
  content: string;
}

export interface SessionErrorPayload {
  message: string;
}

// ---------- 事件列表查询 ----------

/** 时间边界为 epoch 毫秒,由传输层解析 RFC 3339 后传入 */
export interface EventListFilters {
  types?: EventType[];
  createdAtGt?: number;
  createdAtGte?: number;
  createdAtLt?: number;
  createdAtLte?: number;
}

/** 事件列表分页:默认 100、上限 100、默认正序(GLM 与其他列表端点的 20/desc 不同) */
export const DEFAULT_EVENT_PAGE_LIMIT = 100;
export const MAX_EVENT_PAGE_LIMIT = 100;
