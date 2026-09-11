import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersistedEvent, StreamEvent } from "@nano/shared/glm";
import { Radio, RefreshCw, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { getSession, listSessionEvents, sendSessionEvents, subscribeSessionEvents } from "@/api/sessions";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { SessionStatusBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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

function eventBadgeClass(type: string | undefined): string {
  if (!type) return "bg-slate-100 text-slate-600";
  if (type === "session.error") return "bg-red-100 text-red-700";
  if (type.startsWith("user.")) return "bg-blue-100 text-blue-700";
  if (type.startsWith("agent.")) return "bg-violet-100 text-violet-700";
  return "bg-slate-100 text-slate-600";
}

function EventItem({ event }: { event: EventLike }) {
  const record = event as Record<string, unknown>;
  const summary = summarizeEvent(event);
  const time = formatTime(record.processed_at as string | null | undefined);
  const shortTime = formatTimeShort(record.processed_at as string | null | undefined);
  return (
    <li className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-start sm:gap-3">
      <div className="flex w-full items-center justify-between gap-3 sm:w-44 sm:shrink-0 sm:justify-start">
        <Badge variant="secondary" className={cn("font-mono text-[11px] font-normal", eventBadgeClass(record.type as string | undefined))}>
          {String(record.type ?? "event")}
        </Badge>
        <span className="text-muted-foreground text-xs whitespace-nowrap sm:hidden">{shortTime}</span>
      </div>
      <div className="min-w-0 flex-1">
        {summary ? <p className="whitespace-pre-wrap break-words">{summary}</p> : null}
        <details className="mt-1">
          <summary className="text-muted-foreground cursor-pointer text-xs">原始载荷</summary>
          <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs">
            {JSON.stringify(event, null, 2)}
          </pre>
        </details>
      </div>
      <div className="text-muted-foreground hidden w-36 shrink-0 text-right text-xs sm:block">
        {time}
      </div>
    </li>
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
      <Link to="/sessions" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline md:hidden">
        ← 返回 Sessions
      </Link>
      <PageHeader
        title={session.title ?? shortId(session.id)}
        description={`Agent: ${session.agent.name} · environment: ${shortId(session.environment_id)}`}
        actions={
          <>
            <SessionStatusBadge status={session.status} />
            <label className="text-muted-foreground flex items-center gap-2 text-sm">
              <Radio className={cn("size-4", live && "text-emerald-600")} />
              实时
              <Switch checked={live} onCheckedChange={setLive} />
            </label>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-4">
        {[
          ["输入 tokens", formatNumber(session.usage.input_tokens)],
          ["输出 tokens", formatNumber(session.usage.output_tokens)],
          ["缓存命中", formatNumber(session.usage.cache_read_input_tokens)],
          ["活跃时长", `${session.stats.active_seconds.toFixed(1)}s`],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="pt-0">
              <div className="text-muted-foreground text-xs">{label}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-sm">事件流</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "events"] })}
          >
            <RefreshCw /> 刷新历史
          </Button>
        </CardHeader>
        <CardContent>
          {streamError ? <p className="text-destructive mb-2 text-sm">实时流断开:{streamError}</p> : null}
          {eventsQuery.isError ? (
            <QueryError error={eventsQuery.error} />
          ) : (
            <ul className="divide-y">
              {history.map((event) => (
                <EventItem key={event.id} event={event} />
              ))}
              {mergedLive.map((event, i) => (
                <EventItem key={(event as Record<string, unknown>).id as string | undefined ?? `live-${i}`} event={event} />
              ))}
              {history.length === 0 && mergedLive.length === 0 ? (
                <li className="text-muted-foreground py-8 text-center text-sm">
                  {eventsQuery.isPending ? "加载事件中…" : "暂无事件"}
                </li>
              ) : null}
            </ul>
          )}
          <div ref={bottomRef} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
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
            <span className="text-muted-foreground hidden text-xs sm:inline">⌘/Ctrl + Enter 发送</span>
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
        </CardContent>
      </Card>

      <Separator />

      <div className="hidden md:block">
        <Link to="/sessions" className="text-muted-foreground text-sm hover:underline">
          ← 返回 Sessions
        </Link>
      </div>
    </div>
  );
}
