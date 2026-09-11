import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PersistedEvent, SessionFileResource, SessionResourceResponse, StreamEvent } from "@nano/shared/glm";
import { Archive, Inbox, Paperclip, Send, Unlink } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { listFiles } from "@/api/files";
import {
  addSessionFileResource,
  archiveSession,
  deleteSessionFileResource,
  getSession,
  listSessionEvents,
  listSessionResources,
  sendSessionEvents,
  subscribeSessionEvents,
} from "@/api/sessions";
import { BackLink } from "@/components/back-link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { SectionCard } from "@/components/section-card";
import { SessionStatusBadge, StatusBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

/** 归档后会话只读;重复归档服务端返回 409 session_archived */
function ArchiveSessionDialog({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => archiveSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setOpen(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Archive /> 归档
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>归档会话?</DialogTitle>
          <DialogDescription>
            归档后会话变为只读:不能再发送消息或改动资源,该操作不可恢复。
          </DialogDescription>
        </DialogHeader>
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="destructive" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "归档中…" : "确认归档"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 挂载已上传的托管文件到会话;mount_path 省略时默认 /mnt/session/uploads/{file_id} */
function AddSessionFileDialog({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [fileId, setFileId] = useState("");
  const [mountPath, setMountPath] = useState("");
  const [attempted, setAttempted] = useState(false);
  const queryClient = useQueryClient();

  const filesQuery = useQuery({
    queryKey: ["files", "for-mount"],
    queryFn: () => listFiles({ limit: 50 }),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const files = filesQuery.data?.data ?? [];

  function close() {
    setOpen(false);
    setFileId("");
    setMountPath("");
    setAttempted(false);
  }

  const mutation = useMutation({
    mutationFn: () =>
      addSessionFileResource(sessionId, {
        type: "file",
        file_id: fileId,
        ...(mountPath.trim() ? { mount_path: mountPath.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "resources"] });
      close();
    },
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        <Paperclip /> 挂载文件
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>挂载文件</DialogTitle>
          <DialogDescription>
            文件会出现在沙箱的 /mnt/session/uploads 下,会话内只读。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>托管文件</Label>
            <Select value={fileId} onValueChange={setFileId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={files.length === 0 ? "暂无可选文件" : "选择文件"} />
              </SelectTrigger>
              <SelectContent>
                {files.map((file) => (
                  <SelectItem key={file.id} value={file.id}>
                    {file.filename} ({shortId(file.id)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {files.length === 0 && !filesQuery.isPending ? (
              <p className="text-muted-foreground text-xs">请先在 Files 页面上传文件。</p>
            ) : null}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="mount-path">挂载路径(可选)</Label>
            <Input
              id="mount-path"
              className="font-mono"
              value={mountPath}
              onChange={(e) => setMountPath(e.target.value)}
              placeholder="/mnt/session/uploads/…(留空用默认)"
            />
          </div>
        </div>
        {attempted && !fileId ? <p className="text-destructive text-sm">请选择要挂载的文件</p> : null}
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={close}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => {
              setAttempted(true);
              if (fileId) mutation.mutate();
            }}
          >
            {mutation.isPending ? "挂载中…" : "挂载"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 资源挂载卡片:列出已挂载的文件与 memory store;文件可移除,memory store 随会话 */
function ResourcesSection({ sessionId, archived }: { sessionId: string; archived: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["sessions", sessionId, "resources"],
    queryFn: () => listSessionResources(sessionId, { limit: 200 }),
  });
  const removeMutation = useMutation({
    mutationFn: (resourceId: string) => deleteSessionFileResource(sessionId, resourceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "resources"] });
    },
  });

  const resources = query.data?.data ?? [];
  const fileResources = resources.filter((item): item is SessionFileResource => item.type === "file");
  const memoryResources = resources.filter(
    (item): item is Extract<SessionResourceResponse, { type: "memory_store" }> => item.type === "memory_store",
  );

  return (
    <SectionCard
      title="资源挂载"
      action={
        <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
          刷新
        </RefreshButton>
      }
    >
      {query.isPending ? (
        <p className="text-muted-foreground text-sm">加载中…</p>
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : resources.length === 0 ? (
        <EmptyState
          icon={Paperclip}
          title="暂无挂载资源"
          description="挂载托管文件后,会话可在沙箱的 /mnt/session/uploads 下读取它。"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>资源</TableHead>
              <TableHead className="hidden md:table-cell">挂载路径</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {memoryResources.map((resource) => (
              <TableRow key={resource.memory_store_id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[11px] font-normal">
                      memory_store
                    </Badge>
                    <span className="truncate text-sm">{resource.name}</span>
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs">
                    {resource.access === "read_write" ? "可读写" : "只读"} · 随会话挂载,不可单独移除
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                  {resource.mount_path}
                </TableCell>
                <TableCell className="text-right text-muted-foreground text-xs">—</TableCell>
              </TableRow>
            ))}
            {fileResources.map((resource) => (
              <TableRow key={resource.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[11px] font-normal">
                      file
                    </Badge>
                    <span className="font-mono text-xs">{shortId(resource.file_id)}</span>
                  </span>
                  <span className="text-muted-foreground mt-0.5 block text-xs tabular-nums">
                    挂载于 {formatTime(resource.created_at)}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                  {resource.mount_path}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={archived || removeMutation.isPending}
                    onClick={() => removeMutation.mutate(resource.id)}
                  >
                    <Unlink /> 移除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {removeMutation.isError ? (
        <p className="text-destructive mt-2 text-sm">{(removeMutation.error as Error).message}</p>
      ) : null}
    </SectionCard>
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
            {!session.archived_at ? <ArchiveSessionDialog sessionId={session.id} /> : null}
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

      <ResourcesSection sessionId={session.id} archived={session.archived_at !== null} />

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
