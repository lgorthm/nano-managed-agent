import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersistedEvent, StreamEvent } from "@nano/shared/glm";
import { Inbox, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { getSession, listSessionEvents, sendSessionEvents, subscribeSessionEvents } from "@/api/sessions";
import { BackLink } from "@/components/back-link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { SectionCard } from "@/components/section-card";
import { SessionStatusBadge, StatusBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatNumber, formatTime, formatTimeShort, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

type EventLike = PersistedEvent | StreamEvent;

/** 从事件载荷里尽力提取一段人类可读的摘要 */
function summarizeEvent(event: EventLike): string {
  const record = event as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "object" && block !== null && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        return typeof block === "object" && block !== null && "type" in block
          ? `[${String((block as { type: unknown }).type)}]`
          : "";
      })
      .join(" ")
      .slice(0, 300);
  }
  if (typeof record.text === "string") return record.text.slice(0, 300);
  if (typeof record.message === "string") return record.message.slice(0, 300);
  return "";
}

/** 事件类型徽章:user 消息走描边、agent 走正向 tint、错误走负向 tint,其余中性 */
function EventBadge({ type }: { type: string | undefined }) {
  if (!type) return <StatusBadge tint="tint-neutral">event</StatusBadge>;
  if (type === "session.error") return <StatusBadge tint="tint-negative">{type}</StatusBadge>;
  if (type.startsWith("user.")) {
    return <Badge variant="outline" className="font-mono text-[11px] font-normal">{type}</Badge>;
  }
  if (type.startsWith("agent.")) {
    return <StatusBadge tint="tint-positive" className="font-mono text-[11px] font-normal">{type}</StatusBadge>;
  }
  return <StatusBadge tint="tint-neutral" className="font-mono text-[11px] font-normal">{type}</StatusBadge>;
}

function EventItem({ event }: { event: EventLike }) {
  const record = event as Record<string, unknown>;
  const summary = summarizeEvent(event);
  const time = formatTime(record.processed_at as string | null | undefined);
  const shortTime = formatTimeShort(record.processed_at as string | null | undefined);
  return (
    <li className="flex flex-col gap-1.5 py-3 text-sm sm:flex-row sm:items-start sm:gap-4">
      <div className="flex w-full items-center justify-between gap-3 sm:w-48 sm:shrink-0 sm:justify-start">
        <EventBadge type={record.type as string | undefined} />
        <span className="text-muted-foreground text-xs whitespace-nowrap tabular-nums sm:hidden">{shortTime}</span>
      </div>
      <div className="min-w-0 flex-1">
        {summary ? <p className="whitespace-pre-wrap break-words leading-relaxed">{summary}</p> : null}
        <details className="mt-1 group">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs transition-colors select-none">
            原始载荷
          </summary>
          <pre className="bg-muted mt-1.5 max-h-64 overflow-auto rounded-md p-2.5 font-mono text-xs leading-relaxed">
            {JSON.stringify(event, null, 2)}
          </pre>
        </details>
      </div>
      <div className="text-muted-foreground hidden w-40 shrink-0 text-right text-xs tabular-nums sm:block">
        {time}
      </div>
    </li>
  );
}

function StatCell({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 font-mono text-lg font-medium tabular-nums">
        {value}
        {unit ? <span className="text-muted-foreground ml-0.5 text-sm font-normal">{unit}</span> : null}
      </div>
    </div>
  );
}

export function SessionDetailPage() {
  const { sessionId } = useParams();
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  const [draft, setDraft] = useState("");
  const [liveEvents, setLiveEvents] = useState<EventLike[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const sessionQuery = useQuery({
    queryKey: ["sessions", sessionId],
    queryFn: () => getSession(sessionId!),
    enabled: sessionId !== undefined,
  });
  const eventsQuery = useQuery({
    queryKey: ["sessions", sessionId, "events"],
    queryFn: () => listSessionEvents(sessionId!, { order: "desc", limit: 100 }),
    enabled: sessionId !== undefined,
  });

  // 历史事件按时间倒序拉取(取最新 100 条),展示时反转为正序
  const history = useMemo(() => {
    if (!eventsQuery.data) return [] as PersistedEvent[];
    return [...eventsQuery.data.data].reverse();
  }, [eventsQuery.data]);

  // 历史与实时流之间按事件 id 去重(SSE 只推连接后的新事件)
  const historyIds = useMemo(() => new Set(history.map((e) => e.id)), [history]);
  const mergedLive = liveEvents.filter((e) => {
    const id = (e as Record<string, unknown>).id;
    return typeof id !== "string" || !historyIds.has(id);
  });

  useEffect(() => {
    if (!live || !sessionId) return;
    const controller = new AbortController();
    setStreamError(null);
    subscribeSessionEvents(
      sessionId,
      (event) => setLiveEvents((prev) => [...prev, event]),
      controller.signal,
    ).catch((err: unknown) => {
      if (!controller.signal.aborted) {
        setStreamError(err instanceof Error ? err.message : String(err));
        setLive(false);
      }
    });
    return () => controller.abort();
  }, [live, sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length, liveEvents.length]);

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      sendSessionEvents(sessionId!, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      }),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "events"] });
    },
  });

  if (sessionId === undefined) return null;
  if (sessionQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (sessionQuery.isError) return <QueryError error={sessionQuery.error} />;

  const session = sessionQuery.data;

  return (
    <div className="space-y-4">
      <title>nano console — {session.title ?? shortId(session.id)}</title>
      <BackLink to="/sessions" label="返回 Sessions" />
      <PageHeader
        title={session.title ?? shortId(session.id)}
        description={`Agent: ${session.agent.name} · environment: ${shortId(session.environment_id)}`}
        actions={
          <>
            <SessionStatusBadge status={session.status} />
            <label className="text-muted-foreground flex items-center gap-2 text-sm">
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  live ? "bg-pine-600 animate-pulse dark:bg-pine-500" : "bg-muted-foreground/40",
                )}
              />
              实时
              <Switch checked={live} onCheckedChange={setLive} />
            </label>
          </>
        }
      />

      {/* 单块指标条:发丝线分隔,避免四张等宽小卡片碎 */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
        <StatCell label="输入 tokens" value={formatNumber(session.usage.input_tokens)} />
        <StatCell label="输出 tokens" value={formatNumber(session.usage.output_tokens)} />
        <StatCell label="缓存命中" value={formatNumber(session.usage.cache_read_input_tokens)} />
        <StatCell label="活跃时长" value={session.stats.active_seconds.toFixed(1)} unit="s" />
      </div>

      <SectionCard
        title="事件流"
        action={
          <RefreshButton
            isFetching={eventsQuery.isFetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "events"] })}
          >
            刷新历史
          </RefreshButton>
        }
      >
        {streamError ? (
          <p className="text-destructive mb-3 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
            实时流断开:{streamError}
          </p>
        ) : null}
        {eventsQuery.isError ? (
          <QueryError error={eventsQuery.error} />
        ) : history.length === 0 && mergedLive.length === 0 && !eventsQuery.isPending ? (
          <EmptyState
            icon={Inbox}
            title="暂无事件"
            description="这个会话还没有任何事件;在下方发送一条 user.message 就能看到事件流跑起来。"
          />
        ) : eventsQuery.isPending ? (
          <div className="space-y-4 py-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <ul className="divide-y divide-border/70">
            {history.map((event) => (
              <EventItem key={event.id} event={event} />
            ))}
            {mergedLive.map((event, i) => (
              <EventItem key={(event as Record<string, unknown>).id as string | undefined ?? `live-${i}`} event={event} />
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </SectionCard>

      <SectionCard title="发送消息" contentClassName="space-y-3">
        <Textarea
          rows={3}
          value={draft}
          placeholder="发送 user.message 给会话…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
              sendMutation.mutate(draft.trim());
            }
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground hidden font-mono text-xs sm:inline">⌘/Ctrl + Enter 发送</span>
          <Button
            size="sm"
            disabled={!draft.trim() || sendMutation.isPending}
            onClick={() => sendMutation.mutate(draft.trim())}
          >
            <Send /> {sendMutation.isPending ? "发送中…" : "发送"}
          </Button>
        </div>
        {sendMutation.isError ? (
          <p className="text-destructive text-sm">{(sendMutation.error as Error).message}</p>
        ) : null}
      </SectionCard>

      <div className="hidden md:block">
        <BackLink to="/sessions" label="返回 Sessions" desktopOnly />
      </div>
    </div>
  );
}
