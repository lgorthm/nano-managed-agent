/**
 * 会话事件时间线(mini-map):输入/模型/工具三条泳道,按 processed_at 在时间轴上定位事件块。
 * tool_use↔tool_result、span start↔end 配对为区间块并计算耗时,失败调用染红;
 * hover 浮层显示事件名/时间区间/总计耗时,点击块联动选中事件(与左栏列表共享 key)。
 */
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type TimelineLane = "input" | "model" | "tool";

export interface TimelineItem {
  /** 与事件列表行一致的 key(优先事件 id) */
  key: string;
  lane: TimelineLane;
  type: string;
  label: string;
  /** 副标题:工具名或文本摘要首行 */
  detail?: string;
  start: number;
  /** 瞬时事件 end === start */
  end: number;
  error?: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  "user.message": "用户消息",
  "user.interrupt": "打断",
  "user.tool_confirmation": "工具确认",
  "user.define_outcome": "定义结果",
  "user.tool_result": "工具结果(用户)",
  "user.custom_tool_result": "自定义工具结果",
  "system.message": "系统消息",
  "agent.thread_context_compacted": "上下文压缩",
  "agent.message": "Agent 消息",
  "agent.thinking": "思考",
  "agent.thread_message_received": "线程消息(收)",
  "agent.thread_message_sent": "线程消息(发)",
  "agent.tool_use": "工具调用",
  "agent.tool_result": "工具结果",
  "agent.mcp_tool_use": "MCP 工具调用",
  "agent.mcp_tool_result": "MCP 工具结果",
  "agent.custom_tool_use": "自定义工具调用",
  "span.model_request_start": "模型请求",
  "span.model_request_end": "模型请求结束",
  "span.outcome_evaluation_start": "结果评估",
  "span.outcome_evaluation_end": "结果评估结束",
  "session.error": "会话错误",
};

/** 事件类型 → 泳道;null 表示不进时间线(session.* 元事件等) */
const LANE_OF_TYPE: Record<string, TimelineLane> = {
  "user.message": "input",
  "user.interrupt": "input",
  "user.tool_confirmation": "input",
  "user.define_outcome": "input",
  "system.message": "input",
  "agent.thread_context_compacted": "input",
  "agent.message": "model",
  "agent.thinking": "model",
  "agent.thread_message_received": "model",
  "agent.thread_message_sent": "model",
  "session.error": "model",
  "agent.tool_use": "tool",
  "agent.mcp_tool_use": "tool",
  "agent.custom_tool_use": "tool",
  "agent.tool_result": "tool",
  "agent.mcp_tool_result": "tool",
  "user.tool_result": "tool",
  "user.custom_tool_result": "tool",
};

export function laneOfType(type: unknown): TimelineLane | null {
  if (typeof type !== "string") return null;
  if (type in LANE_OF_TYPE) return LANE_OF_TYPE[type]!;
  if (type.startsWith("span.")) return "model";
  return null;
}

const TOOL_USE_TYPES = new Set(["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"]);
const TOOL_RESULT_TYPES = new Set([
  "agent.tool_result",
  "agent.mcp_tool_result",
  "user.tool_result",
  "user.custom_tool_result",
]);
const SPAN_END_OF: Record<string, string> = {
  "span.model_request_start": "span.model_request_end",
  "span.outcome_evaluation_start": "span.outcome_evaluation_end",
};

function epochOf(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function snippet(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 0 ? t.slice(0, 36) : undefined;
}

/** 从 content 块数组或顶层 text/message 提取摘要首行 */
function textDetail(record: Record<string, unknown>): string | undefined {
  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string") {
        const s = snippet((block as { text: string }).text);
        if (s) return s;
      }
    }
    return undefined;
  }
  return snippet(record.text) ?? snippet(record.message);
}

/**
 * 把会话事件编译为时间线块:tool_use 与对应 tool_result 合并为区间块,
 * 排队中(processed_at 为空)的事件无法定位,不产生块。
 */
export function buildTimelineItems(events: Array<Record<string, unknown>>): TimelineItem[] {
  // tool_use 事件 id → result 的落地时间与错误标记(§2.1:tool_use 的 id 即 tool_use_id)
  const resultByUseId = new Map<string, { at: number; isError: boolean }>();
  for (const event of events) {
    if (!TOOL_RESULT_TYPES.has(String(event.type))) continue;
    const at = epochOf(event.processed_at);
    if (typeof event.tool_use_id !== "string" || at === null) continue;
    resultByUseId.set(event.tool_use_id, { at, isError: event.is_error === true });
  }

  const items: TimelineItem[] = [];
  const pairedUseIds = new Set<string>();
  let pendingSpanStart: { type: string; at: number } | null = null;

  events.forEach((event, index) => {
    const type = typeof event.type === "string" ? event.type : "event";
    const at = epochOf(event.processed_at);
    if (at === null) return;
    const key = typeof event.id === "string" ? event.id : `${type}-${index}`;
    const label = TYPE_LABELS[type] ?? type;

    if (TOOL_USE_TYPES.has(type)) {
      if (typeof event.id === "string") pairedUseIds.add(event.id);
      const result = typeof event.id === "string" ? resultByUseId.get(event.id) : undefined;
      items.push({
        key,
        lane: "tool",
        type,
        label,
        detail: typeof event.name === "string" ? event.name : undefined,
        start: at,
        end: result?.at ?? at,
        error: result?.isError,
      });
      return;
    }
    if (TOOL_RESULT_TYPES.has(type)) {
      // 已并入配对区间块的 result 不再单独出块
      if (typeof event.tool_use_id === "string" && pairedUseIds.has(event.tool_use_id)) return;
      items.push({
        key,
        lane: "tool",
        type,
        label,
        detail: textDetail(event),
        start: at,
        end: at,
        error: event.is_error === true,
      });
      return;
    }
    if (SPAN_END_OF[type]) {
      pendingSpanStart = { type, at };
      return;
    }
    if (type.startsWith("span.")) {
      if (pendingSpanStart && SPAN_END_OF[pendingSpanStart.type] === type) {
        items.push({
          key,
          lane: "model",
          type: pendingSpanStart.type,
          label: TYPE_LABELS[pendingSpanStart.type] ?? pendingSpanStart.type,
          start: pendingSpanStart.at,
          end: at,
        });
        pendingSpanStart = null;
        return;
      }
      // 孤立 end / ongoing 心跳:退化为瞬时块
    }
    const lane = laneOfType(type);
    if (!lane) return;
    items.push({
      key,
      lane,
      type,
      label,
      detail: lane === "tool" ? undefined : textDetail(event),
      start: at,
      end: at,
      error: type === "session.error",
    });
  });
  return items;
}

const LANES: Array<{ id: TimelineLane; label: string }> = [
  { id: "input", label: "输入" },
  { id: "model", label: "模型" },
  { id: "tool", label: "工具" },
];

const LANE_BLOCK: Record<TimelineLane, string> = {
  input: "bg-chart-5/70 hover:bg-chart-5",
  model: "bg-chart-1/70 hover:bg-chart-1",
  tool: "bg-chart-4/70 hover:bg-chart-4",
};

function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function formatSpanDuration(ms: number): string {
  if (ms <= 0) return "0 毫秒";
  if (ms < 1000) return `${ms} 毫秒`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function SessionTimeline({
  items,
  selectedId,
  onSelect,
  className,
}: {
  items: TimelineItem[];
  selectedId?: string | null;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  const [hovered, setHovered] = useState<TimelineItem | null>(null);
  const [hoverX, setHoverX] = useState(50);

  // 时间轴区间取全部块的极值,与泳道筛选无关,保证轴稳定
  const { t0, span } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const item of items) {
      lo = Math.min(lo, item.start);
      hi = Math.max(hi, item.end);
    }
    if (lo === Infinity) return { t0: 0, span: 1 };
    return { t0: lo, span: Math.max(hi - lo, 1) };
  }, [items]);

  if (items.length === 0) return null;
  const pct = (t: number) => ((t - t0) / span) * 100;
  const t1 = t0 + span;

  return (
    <div className={cn("relative", className)}>
      {hovered ? (
        <div
          className="bg-foreground text-background pointer-events-none absolute top-0 z-20 w-max max-w-72 -translate-x-1/2 -translate-y-full rounded-md px-3 py-2 text-xs shadow-lg"
          style={{ left: `${Math.min(Math.max(hoverX, 14), 86)}%` }}
          role="tooltip"
        >
          <div className="font-medium">
            {hovered.label}
            {hovered.detail ? <span className="opacity-70"> · {hovered.detail}</span> : null}
          </div>
          <div className="mt-0.5 tabular-nums opacity-80">
            {formatClock(hovered.start)} ~ {formatClock(hovered.end)}
          </div>
          <div className="tabular-nums opacity-80">
            总计 {formatSpanDuration(hovered.end - hovered.start)}
            {hovered.error ? " · 失败" : ""}
          </div>
          <span
            aria-hidden
            className="bg-foreground absolute top-full left-1/2 size-2 -translate-x-1/2 -translate-y-1 rotate-45 rounded-[2px]"
          />
        </div>
      ) : null}

      <div className="space-y-1">
        {LANES.map((lane) => (
          <div key={lane.id} className="flex items-center gap-2">
            <span className="text-muted-foreground w-9 shrink-0 text-right text-xs">{lane.label}</span>
            <div className="bg-muted/60 relative h-3.5 flex-1 rounded-sm">
              {items
                .filter((item) => item.lane === lane.id)
                .map((item) => {
                  const left = pct(item.start);
                  const width = Math.max(pct(item.end) - left, 0.6);
                  const selected = item.key === selectedId;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={cn(
                        "absolute inset-y-0 min-w-[5px] rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                        item.error ? "bg-destructive/80 hover:bg-destructive" : LANE_BLOCK[item.lane],
                        selected && "outline-foreground/70 z-10 outline-2 outline-offset-1",
                      )}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      aria-label={`${item.label}${item.detail ? ` ${item.detail}` : ""} ${formatClock(item.start)}`}
                      onPointerEnter={() => {
                        setHovered(item);
                        setHoverX(left + width / 2);
                      }}
                      onPointerLeave={() => setHovered(null)}
                      onFocus={() => {
                        setHovered(item);
                        setHoverX(left + width / 2);
                      }}
                      onBlur={() => setHovered(null)}
                      onClick={() => onSelect?.(item.key)}
                    />
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      <div className="text-muted-foreground mt-1.5 flex items-center justify-between pl-[2.75rem] text-[11px] tabular-nums">
        <span>{formatClock(t0)}</span>
        <span>{items.length} 个事件</span>
        <span>{formatClock(t1)}</span>
      </div>
    </div>
  );
}
