import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ManagedFile, PersistedEvent, Session, SessionFileResource, SessionResourceResponse, StreamEvent } from "@nano/shared/glm";
import { Archive, Ban, Check, Copy, Download, Inbox, Paperclip, Send, Unlink, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { downloadFile, listFiles } from "@/api/files";
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
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { KeyValueRow, SectionCard } from "@/components/section-card";
import { SessionLedger, type SessionLedgerHandle } from "@/components/session-ledger";
import { SessionTimeline } from "@/components/session-timeline";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  buildLedger,
  collapseRecords,
  collapsibleSteps,
  collapsibleTurns,
  deriveTimelineSpans,
  filterRecords,
  formatSpanDuration,
  recordMatchesSearch,
  stepKey,
  timelineFocusKeys,
  type LedgerLane,
  type TimelineMode,
  type TimelineRange,
} from "@/lib/session-ledger";
import { formatBytes, formatNumber, formatTime, shortId } from "@/lib/format";
import { saveBlob } from "@/lib/save-blob";
import { cn } from "@/lib/utils";

/** 下载单个会话文件(挂载或产出):取回 blob 后交给浏览器保存 */
function DownloadFileButton({ file }: { file: ManagedFile }) {
  const mutation = useMutation({
    mutationFn: () => downloadFile(file),
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
  });
  return (
    <Button
      size="icon"
      variant="ghost"
      className="text-muted-foreground size-7"
      aria-label={`下载 ${file.filename}`}
      disabled={!file.downloadable || mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      <Download className={cn("size-3.5", mutation.isPending && "animate-pulse")} />
    </Button>
  );
}

type EventLike = PersistedEvent | StreamEvent;

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

/** content 块数组 → 富文本渲染(文本/图片/文档),供事件行摘要与详情面板共用 */
function ContentBlocks({ content }: { content: unknown[] }) {
  return (
    <div className="space-y-2">
      {content.map((block, i) => {
        if (typeof block !== "object" || block === null) return null;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          return (
            <p key={i} className="whitespace-pre-wrap break-words leading-relaxed">
              {b.text}
            </p>
          );
        }
        if (b.type === "image") {
          const source = b.source as { type?: string; media_type?: string; data?: string } | undefined;
          if (source?.type === "base64" && source.media_type && source.data) {
            return (
              <img
                key={i}
                src={`data:${source.media_type};base64,${source.data}`}
                alt={`图片块 ${i + 1}`}
                className="max-h-48 rounded-md border"
              />
            );
          }
          return null;
        }
        if (b.type === "document") {
          return (
            <p key={i} className="text-muted-foreground text-xs">
              [文档] {typeof b.title === "string" ? b.title : `块 ${i + 1}`}
            </p>
          );
        }
        return (
          <p key={i} className="text-muted-foreground text-xs">
            [{String(b.type ?? "block")}]
          </p>
        );
      })}
    </div>
  );
}

/** 事件详情:类型/时间/Event ID/配对耗时 + 载荷富文本 + 原始 JSON;onClose 省略时隐藏关闭按钮(弹窗场景) */
function EventDetailPanel({
  event,
  duration,
  onClose,
}: {
  event: EventLike;
  duration?: number;
  onClose?: () => void;
}) {
  const record = event as Record<string, unknown>;
  const type = record.type as string | undefined;
  const id = record.id as string | undefined;
  const hasDuration = duration !== undefined && duration > 0;

  return (
    <div className="border-border/70 bg-card min-w-0 space-y-4 rounded-lg border p-4 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <EventBadge type={type} />
        {onClose ? (
          <Button size="icon" variant="ghost" className="text-muted-foreground size-7" aria-label="关闭详情" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        ) : null}
      </div>

      <div className="space-y-2 text-sm">
        <KeyValueRow label="时间">{formatTime(record.processed_at as string | null | undefined)}</KeyValueRow>
        {hasDuration ? <KeyValueRow label="耗时">{formatSpanDuration(duration!)}</KeyValueRow> : null}
        {typeof id === "string" ? (
          <KeyValueRow label="Event ID">
            <span className="font-mono text-xs break-all">{id}</span>
          </KeyValueRow>
        ) : null}
      </div>

      <div className="border-border/70 space-y-3 border-t pt-3 text-sm">
        <h4 className="text-muted-foreground text-[13px] font-medium tracking-wide">载荷内容</h4>
        {Array.isArray(record.content) ? (
          <ContentBlocks content={record.content} />
        ) : typeof record.name === "string" ? (
          <div className="space-y-2">
            <span className="font-mono text-xs break-all">{String(record.name)}</span>
            <pre className="bg-muted max-h-56 overflow-auto rounded-md p-2.5 font-mono text-xs leading-relaxed">
              {JSON.stringify(record.input ?? {}, null, 2)}
            </pre>
          </div>
        ) : typeof record.text === "string" ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{record.text}</p>
        ) : typeof record.message === "string" ? (
          <p className="whitespace-pre-wrap break-words leading-relaxed">{record.message}</p>
        ) : record.stop_reason ? (
          <pre className="bg-muted max-h-56 overflow-auto rounded-md p-2.5 font-mono text-xs leading-relaxed">
            {JSON.stringify(record.stop_reason, null, 2)}
          </pre>
        ) : (
          <p className="text-muted-foreground text-xs">无可渲染的文本载荷,查看下方原始 JSON。</p>
        )}
        {record.is_error === true ? (
          <StatusBadge tint="tint-negative" className="font-mono text-[11px] font-normal">
            is_error
          </StatusBadge>
        ) : null}
      </div>

      <details className="group border-border/70 border-t pt-3">
        <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs transition-colors select-none">
          原始载荷
        </summary>
        <pre className="bg-muted mt-1.5 max-h-64 overflow-auto rounded-md p-2.5 font-mono text-xs leading-relaxed">
          {JSON.stringify(event, null, 2)}
        </pre>
      </details>
    </div>
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

/** 长 ID 复制按钮:点击写入剪贴板,短暂显示对勾反馈 */
function CopyIdButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="复制"
      className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center transition-colors"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // 剪贴板不可用(非安全上下文等):静默失败
        }
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
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
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "files"] });
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

/** 待审批工具调用(§4.3):最后一个 status_idle 为 requires_action 且尚未有 tool_result 的 tool_use */
function PendingApprovals({
  sessionId,
  events,
  archived,
}: {
  sessionId: string;
  events: EventLike[];
  archived: boolean;
}) {
  const queryClient = useQueryClient();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const confirmMutation = useMutation({
    mutationFn: (input: { toolUseId: string; result: "allow" | "deny" }) =>
      sendSessionEvents(sessionId, {
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: input.toolUseId,
            result: input.result,
            ...(input.result === "deny" && reasons[input.toolUseId]?.trim()
              ? { deny_message: reasons[input.toolUseId]!.trim() }
              : {}),
          },
        ],
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "events"] });
    },
  });

  const list = [...events].reverse();
  const lastIdle = list.find((event) => (event as Record<string, unknown>).type === "session.status_idle");
  const stop = (lastIdle as Record<string, unknown> | undefined)?.stop_reason as
    | { type?: string; event_ids?: string[] }
    | undefined;
  const pendingIds = stop?.type === "requires_action" ? (stop.event_ids ?? []) : [];
  const resultIds = new Set(
    events
      .filter((event) => (event as Record<string, unknown>).type === "agent.tool_result")
      .map((event) => (event as Record<string, unknown>).tool_use_id),
  );
  const pending = pendingIds
    .filter((id) => !resultIds.has(id))
    .map((id) => ({
      id,
      use: events.find((event) => event.id === id && (event as Record<string, unknown>).type === "agent.tool_use"),
    }))
    .filter((item): item is { id: string; use: EventLike } => item.use !== undefined);

  if (pending.length === 0 || archived) return null;

  return (
    <SectionCard title="等待审批" contentClassName="space-y-3">
      <p className="text-muted-foreground text-sm">
        Agent 请求调用受审批策略(always_ask)约束的工具,会话已挂起;全部裁决后会自动继续。
      </p>
      {pending.map(({ id, use }) => {
        const record = use as Record<string, unknown>;
        return (
          <div key={id} className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-[11px] font-normal">
                {String(record.name)}
              </Badge>
              <span className="text-muted-foreground font-mono text-xs">{shortId(id)}</span>
            </div>
            <pre className="bg-muted max-h-40 overflow-auto rounded-md p-2 font-mono text-xs">
              {JSON.stringify(record.input ?? {}, null, 2)}
            </pre>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                className="flex-1"
                placeholder="拒绝原因(仅拒绝时随 deny_message 提交,可选)"
                value={reasons[id] ?? ""}
                onChange={(e) => setReasons((prev) => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={confirmMutation.isPending}
                  onClick={() => confirmMutation.mutate({ toolUseId: id, result: "allow" })}
                >
                  允许
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={confirmMutation.isPending}
                  onClick={() => confirmMutation.mutate({ toolUseId: id, result: "deny" })}
                >
                  拒绝
                </Button>
              </div>
            </div>
          </div>
        );
      })}
      {confirmMutation.isError ? (
        <p className="text-destructive text-sm">{(confirmMutation.error as Error).message}</p>
      ) : null}
    </SectionCard>
  );
}

/** Token 用量 tab:顶部指标条 + 会话元信息 */
function UsageSection({ session }: { session: Session }) {
  const metadataEntries = Object.entries(session.metadata ?? {});
  return (
    <>
      {/* 单块指标条:发丝线分隔,避免四张等宽小卡片碎 */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
        <StatCell label="输入 tokens" value={formatNumber(session.usage.input_tokens)} />
        <StatCell label="输出 tokens" value={formatNumber(session.usage.output_tokens)} />
        <StatCell label="缓存命中" value={formatNumber(session.usage.cache_read_input_tokens)} />
        <StatCell label="活跃时长" value={session.stats.active_seconds.toFixed(1)} unit="s" />
      </div>

      <SectionCard title="会话信息" contentClassName="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        <KeyValueRow label="Session ID">
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs break-all">{session.id}</span>
            <CopyIdButton value={session.id} />
          </span>
        </KeyValueRow>
        <KeyValueRow label="Agent">
          {session.agent.name}
          <span className="text-muted-foreground text-xs"> · v{session.agent.version}</span>
        </KeyValueRow>
        <KeyValueRow label="Environment">
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-xs">{session.environment_id}</span>
            <CopyIdButton value={session.environment_id} />
          </span>
        </KeyValueRow>
        <KeyValueRow label="创建时间">{formatTime(session.created_at)}</KeyValueRow>
        <KeyValueRow label="最近更新">{formatTime(session.updated_at)}</KeyValueRow>
        {session.archived_at ? <KeyValueRow label="归档时间">{formatTime(session.archived_at)}</KeyValueRow> : null}
        {session.vault_ids.length > 0 ? (
          <KeyValueRow label="Vaults">
            <span className="font-mono text-xs">{session.vault_ids.map((id) => shortId(id)).join(", ")}</span>
          </KeyValueRow>
        ) : null}
        {metadataEntries.map(([key, value]) => (
          <KeyValueRow key={key} label={key}>
            <span className="font-mono text-xs break-all">
              {typeof value === "string" ? value : JSON.stringify(value)}
            </span>
          </KeyValueRow>
        ))}
      </SectionCard>
    </>
  );
}

/**
 * 会话文件卡片:数据源是 files 的 scope_id 过滤(挂载 ∪ 产出),
 * 用 session_resources 的挂载集合给行标注来源;产出行提供下载,
 * 挂载行可移除。memory store 资源仍来自 session_resources。
 */
function ResourcesSection({ sessionId, archived }: { sessionId: string; archived: boolean }) {
  const queryClient = useQueryClient();
  const resourcesQuery = useQuery({
    queryKey: ["sessions", sessionId, "resources"],
    queryFn: () => listSessionResources(sessionId, { limit: 200 }),
  });
  const filesQuery = useQuery({
    queryKey: ["sessions", sessionId, "files"],
    queryFn: () => listFiles({ scope_id: sessionId, limit: 200 }),
  });
  const removeMutation = useMutation({
    mutationFn: (resourceId: string) => deleteSessionFileResource(sessionId, resourceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "resources"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "files"] });
    },
  });

  const resources = resourcesQuery.data?.data ?? [];
  const fileResources = resources.filter((item): item is SessionFileResource => item.type === "file");
  const mountsByFileId = new Map(fileResources.map((resource) => [resource.file_id, resource]));
  const memoryResources = resources.filter(
    (item): item is Extract<SessionResourceResponse, { type: "memory_store" }> => item.type === "memory_store",
  );
  const files = filesQuery.data?.data ?? [];
  const loading = resourcesQuery.isPending || filesQuery.isPending;

  return (
    <SectionCard
      title="会话文件"
      action={
        <>
          <RefreshButton
            isFetching={resourcesQuery.isFetching || filesQuery.isFetching}
            onClick={() => {
              void resourcesQuery.refetch();
              void filesQuery.refetch();
            }}
          >
            刷新
          </RefreshButton>
          <AddSessionFileDialog sessionId={sessionId} disabled={archived} />
        </>
      }
    >
      {loading ? (
        <p className="text-muted-foreground text-sm">加载中…</p>
      ) : resourcesQuery.isError ? (
        <QueryError error={resourcesQuery.error} />
      ) : filesQuery.isError ? (
        <QueryError error={filesQuery.error} />
      ) : files.length === 0 && memoryResources.length === 0 ? (
        <EmptyState
          icon={Paperclip}
          title="暂无会话文件"
          description="挂载的文件会出现在沙箱的 /mnt/session/uploads 下;Agent 写入 /mnt/session/outputs 的产出也会编目到这里,可随时下载。"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>文件</TableHead>
              <TableHead className="hidden md:table-cell">沙箱路径</TableHead>
              <TableHead className="hidden sm:table-cell">大小</TableHead>
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
                <TableCell className="hidden sm:table-cell" />
                <TableCell className="text-right text-muted-foreground text-xs">—</TableCell>
              </TableRow>
            ))}
            {files.map((file) => {
              const mount = mountsByFileId.get(file.id);
              const isOutput = file.scope?.id === sessionId && mount === undefined;
              return (
                <TableRow key={file.id}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {isOutput ? (
                        <StatusBadge tint="tint-positive" className="font-mono text-[11px] font-normal">
                          产出
                        </StatusBadge>
                      ) : (
                        <Badge variant="outline" className="font-mono text-[11px] font-normal">
                          挂载
                        </Badge>
                      )}
                      <span className="font-mono text-xs">{shortId(file.id)}</span>
                    </span>
                    <span className="text-muted-foreground mt-0.5 block max-w-[28rem] truncate text-xs tabular-nums">
                      {file.filename} · {formatTime(file.created_at)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                    {mount ? mount.mount_path : `/mnt/session/outputs/${file.filename}`}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs tabular-nums sm:table-cell">
                    {formatBytes(file.size_bytes)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center gap-1">
                      <DownloadFileButton file={file} />
                      {mount ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive size-7"
                          aria-label="移除挂载"
                          disabled={archived || removeMutation.isPending}
                          onClick={() => removeMutation.mutate(mount.id)}
                        >
                          <Unlink className="size-3.5" />
                        </Button>
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {removeMutation.isError ? (
        <p className="text-destructive mt-2 text-sm">{(removeMutation.error as Error).message}</p>
      ) : null}
    </SectionCard>
  );
}

type SessionTab = "events" | "usage" | "files";

/** 是否 ≥ lg 断点(与 CSS lg: 一致);用于只在移动端挂载事件详情弹窗 */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia("(min-width: 64rem)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 64rem)");
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

export function SessionDetailPage() {
  const { sessionId } = useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<SessionTab>("events");
  const [live, setLive] = useState(false);
  const [draft, setDraft] = useState("");
  const [liveEvents, setLiveEvents] = useState<EventLike[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [laneFilter, setLaneFilter] = useState<"all" | LedgerLane>("all");
  const [search, setSearch] = useState("");
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("sequence");
  const [focusRange, setFocusRange] = useState<TimelineRange | null>(null);
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set());
  const [collapsedSteps, setCollapsedSteps] = useState<Set<string>>(new Set());
  const isDesktop = useIsDesktop();
  const ledgerRef = useRef<SessionLedgerHandle>(null);

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

  const allEvents = useMemo(() => [...history, ...mergedLive], [history, mergedLive]);

  // 台账数据管线:事件 → 记录(turn/step/配对) → 时间线投影 → 过滤 → 折叠行
  const ledger = useMemo(() => buildLedger(allEvents as Array<Record<string, unknown>>), [allEvents]);
  const timelineModel = useMemo(() => deriveTimelineSpans(ledger, timelineMode), [ledger, timelineMode]);
  const ledgerRecords = useMemo(
    () => filterRecords(ledger, laneFilter, search),
    [ledger, laneFilter, search],
  );
  const ledgerRows = useMemo(
    () => collapseRecords(ledgerRecords, collapsedTurns, collapsedSteps),
    [ledgerRecords, collapsedTurns, collapsedSteps],
  );
  // 搜索命中集合(不限泳道):台账过滤与时间线高亮共用;无关键词时为 null
  const searchMatchKeys = useMemo(() => {
    if (!search.trim()) return null;
    return new Set(ledger.filter((record) => recordMatchesSearch(record, search)).map((record) => record.key));
  }, [ledger, search]);
  // 选区内 key 集合:驱动台账行「选区外压暗」与聚焦滚动
  const focusKeys = useMemo(
    () => (timelineModel && focusRange ? timelineFocusKeys(timelineModel, focusRange) : null),
    [timelineModel, focusRange],
  );
  const collapsibleTurnSet = useMemo(() => collapsibleTurns(ledgerRecords), [ledgerRecords]);
  const collapsibleStepSet = useMemo(() => collapsibleSteps(ledgerRecords), [ledgerRecords]);

  const selectedEvent = useMemo(
    () => allEvents.find((event) => (event as Record<string, unknown>).id === selectedId) ?? null,
    [allEvents, selectedId],
  );
  const selectedDuration = useMemo(() => {
    const record = ledger.find((item) => item.key === selectedId);
    return record?.durationMs ?? undefined;
  }, [ledger, selectedId]);

  // 展开 key 所在的 turn/step(时间线/选区定位到被折叠的记录时由台账回调)
  const revealKey = useCallback(
    (key: string) => {
      const record = ledger.find((item) => item.key === key);
      if (!record) return;
      setCollapsedSteps((prev) => {
        const keyToRemove = stepKey(record.turn, record.step);
        if (!prev.has(keyToRemove)) return prev;
        const next = new Set(prev);
        next.delete(keyToRemove);
        return next;
      });
      setCollapsedTurns((prev) => {
        if (!prev.has(record.turn)) return prev;
        const next = new Set(prev);
        next.delete(record.turn);
        return next;
      });
    },
    [ledger],
  );

  // 时间线/台账点击选中后滚动到对应行;行被折叠时先展开再滚(展开后 ledgerRows 变化重跑本 effect)
  useEffect(() => {
    if (!selectedId || tab !== "events") return;
    if (ledgerRows.some((row) => row.record?.key === selectedId)) {
      ledgerRef.current?.scrollToKey(selectedId);
    } else {
      revealKey(selectedId);
    }
  }, [selectedId, ledgerRows, tab, revealKey]);

  // 拖选提交后滚动到聚焦行(高于一屏顶对齐,否则居中)
  useEffect(() => {
    if (focusRange && focusKeys) ledgerRef.current?.scrollToFocus(focusKeys);
  }, [focusRange, focusKeys]);

  // 重连协议(§7):先补历史再订阅,按事件 id 去重;断线后指数退避自动重连
  useEffect(() => {
    if (!live || !sessionId) return;
    const controller = new AbortController();
    let stopped = false;
    let attempts = 0;
    void (async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          await queryClient.invalidateQueries({ queryKey: ["sessions", sessionId] });
          await queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "events"] });
          await queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "files"] });
          setStreamError(null);
          await subscribeSessionEvents(
            sessionId,
            (event) => {
              attempts = 0; // 收到事件视为连接健康,重置退避
              setLiveEvents((prev) => [...prev, event]);
            },
            controller.signal,
          );
        } catch {
          // 断线(或主动 abort):走下方的重连等待
        }
        if (stopped || controller.signal.aborted) break;
        const delay = Math.min(1000 * 2 ** Math.min(attempts, 4), 15000);
        attempts += 1;
        setStreamError(`实时流断开,约 ${Math.round(delay / 1000)}s 后自动重连(重连前先补拉历史)…`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [live, sessionId, queryClient]);

  // 进入(或切回)事件流 tab 时恢复贴底;新事件到达的跟随由台账组件内部按贴底状态处理
  useEffect(() => {
    if (tab === "events") ledgerRef.current?.jumpToTail();
  }, [tab]);

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      sendSessionEvents(sessionId!, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      }),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "events"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "files"] });
    },
  });

  const interruptMutation = useMutation({
    mutationFn: () => sendSessionEvents(sessionId!, { events: [{ type: "user.interrupt" }] }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId] });
      void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "events"] });
    },
  });

  if (sessionId === undefined) return null;
  if (sessionQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (sessionQuery.isError) return <QueryError error={sessionQuery.error} />;

  const session = sessionQuery.data;
  const archived = session.archived_at !== null;
  const interruptible = !archived && session.status === "running";

  return (
    // 事件流 tab 下页面根 absolute 定位到 app-layout 容器(padding 对应 inset)的一屏内:
    // 脱离文档流后高度确定,固有高度不再把页面撑高,工具栏/时间线/输入框固定、仅列表内部滚动。
    // 其余 tab 保持静态流,内容自然撑开、由 main 滚动。
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as SessionTab)}
      className={cn(
        "flex-1 flex-col gap-4",
        tab === "events"
          ? "absolute inset-x-3 top-3 bottom-3 md:inset-x-5 md:left-3 md:top-5 md:bottom-5"
          : "min-h-full",
      )}
    >
      <title>nano console — {session.title ?? shortId(session.id)}</title>
      {/* 标题与 Agent/环境信息内联在返回链接右侧,与页面级操作同行,压缩头部占高 */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* desktopOnly 样式即"始终显示",此处作为面包屑用 */}
          <BackLink to="/sessions" label="返回 Sessions" desktopOnly />
          <h1 className="min-w-0 truncate text-sm font-semibold">{session.title ?? shortId(session.id)}</h1>
          <span className="text-muted-foreground hidden min-w-0 truncate text-xs sm:inline">
            Agent: {session.agent.name} · environment: {shortId(session.environment_id)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SessionStatusBadge status={session.status} />
          {!archived ? <ArchiveSessionDialog sessionId={session.id} /> : null}
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
        </div>
      </div>

      {/* Cloudflare 风格胶囊导航 */}
      <div className="flex flex-wrap items-center gap-2">
        <TabsList className="border-border/70 border bg-muted/50">
          <TabsTrigger value="events">事件流</TabsTrigger>
          <TabsTrigger value="usage">Token 用量</TabsTrigger>
          <TabsTrigger value="files">会话文件</TabsTrigger>
        </TabsList>
      </div>

      {/* ---------------------------------------------------------------- 事件流(默认 tab)
          整页限高一屏:工具栏/时间线/输入框固定,仅事件列表内部滚动;新事件仅在贴底时自动跟随 */}
      <TabsContent value="events" className="flex min-h-0 flex-col gap-3">
        {streamError ? (
          <p className="text-destructive shrink-0 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm">
            实时流断开:{streamError}
          </p>
        ) : null}

        <div className="shrink-0">
          <PendingApprovals
            sessionId={session.id}
            archived={archived}
            events={[...history, ...mergedLive]}
          />
        </div>

        {/* 工具栏:泳道筛选 + 搜索 + 计数 + 折叠开关 + 刷新历史;时间线轴取全量,不受筛选影响 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Select value={laneFilter} onValueChange={(value) => setLaneFilter(value as "all" | LedgerLane)}>
            <SelectTrigger className="w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部事件</SelectItem>
              <SelectItem value="input">输入</SelectItem>
              <SelectItem value="model">模型</SelectItem>
              <SelectItem value="tool">工具</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="w-48 text-xs"
            placeholder="搜索类型 / 内容 / ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {ledgerRecords.length}/{ledger.length} 条
          </span>
          {collapsibleTurnSet.size > 0 || collapsibleStepSet.size > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => {
                const allCollapsed =
                  [...collapsibleTurnSet].every((turn) => collapsedTurns.has(turn)) &&
                  [...collapsibleStepSet].every((key) => collapsedSteps.has(key));
                if (allCollapsed) {
                  setCollapsedTurns(new Set());
                  setCollapsedSteps(new Set());
                } else {
                  setCollapsedTurns(new Set(collapsibleTurnSet));
                  setCollapsedSteps(new Set(collapsibleStepSet));
                }
              }}
            >
              {[...collapsibleTurnSet].every((turn) => collapsedTurns.has(turn)) &&
              [...collapsibleStepSet].every((key) => collapsedSteps.has(key))
                ? "展开全部"
                : "折叠全部"}
            </Button>
          ) : null}
          <RefreshButton
            isFetching={eventsQuery.isFetching}
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["sessions", sessionId, "events"] })}
          >
            刷新历史
          </RefreshButton>
        </div>

        {/* 交互式时间线:拖选区间聚焦台账、滚轮缩放、右键平移;模式切换在卡片头部右侧 */}
        {timelineModel ? (
          <div className="shrink-0 rounded-lg border bg-card px-4 py-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs font-medium">时间线</span>
              <div className="flex items-center gap-0.5 rounded-md border p-0.5" role="group" aria-label="时间线模式">
                {(["sequence", "duration"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={timelineMode === value}
                    className={cn(
                      "rounded-[5px] px-2 py-0.5 text-xs transition-colors",
                      timelineMode === value
                        ? "bg-background border shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => setTimelineMode(value)}
                  >
                    {value === "sequence" ? "顺序" : "耗时"}
                  </button>
                ))}
              </div>
            </div>
            <SessionTimeline
              model={timelineModel}
              mode={timelineMode}
              range={focusRange}
              onRangeChange={setFocusRange}
              selectedKey={selectedId}
              searchMatchKeys={searchMatchKeys}
              laneFilter={laneFilter}
              onItemSelect={setSelectedId}
              onItemFocus={setSelectedId}
            />
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 gap-4">
          {/* flex 容器:内部台账滚动容器靠 grow 撑满剩余高度,普通 block 会让 grow 失效导致无法滚动 */}
          <div className="border-border/70 flex min-h-0 min-w-0 grow flex-col overflow-hidden rounded-lg border bg-card">
            {eventsQuery.isError ? (
              <div className="p-4">
                <QueryError error={eventsQuery.error} />
              </div>
            ) : history.length === 0 && mergedLive.length === 0 && !eventsQuery.isPending ? (
              <EmptyState
                icon={Inbox}
                title="暂无事件"
                description="这个会话还没有任何事件;在下方发送一条 user.message 就能看到事件流跑起来。"
              />
            ) : eventsQuery.isPending ? (
              <div className="space-y-4 p-4">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : ledgerRows.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">没有匹配筛选条件的事件。</p>
            ) : (
              <SessionLedger
                ref={ledgerRef}
                rows={ledgerRows}
                selectedKey={selectedId}
                focusKeys={focusKeys}
                onSelect={setSelectedId}
                onToggleTurn={(turn) =>
                  setCollapsedTurns((prev) => {
                    const next = new Set(prev);
                    if (next.has(turn)) next.delete(turn);
                    else next.add(turn);
                    return next;
                  })
                }
                onToggleStep={(turn, step) =>
                  setCollapsedSteps((prev) => {
                    const key = stepKey(turn, step);
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                onRevealKey={revealKey}
              />
            )}
          </div>

          {/* 事件详情:桌面端右栏独立滚动;移动端走下方弹窗 */}
          <aside className="hidden w-[21rem] shrink-0 min-h-0 overflow-y-auto lg:block">
            {selectedEvent ? (
              <EventDetailPanel
                event={selectedEvent}
                duration={selectedDuration}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <div className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-xs">
                点击时间线块或台账行查看事件详情
              </div>
            )}
          </aside>
        </div>

        {/* 输入框:作为 flex 尾项常驻视口底部,不随列表滚动 */}
        <div className="border-border/70 shrink-0 rounded-xl border bg-card p-3 shadow-xs">
          <Textarea
            rows={2}
            value={draft}
            disabled={archived}
            placeholder={archived ? "会话已归档(只读),不能发送消息" : "发送 user.message 给会话…"}
            onChange={(e) => setDraft(e.target.value)}
            className="max-h-44 min-h-10 resize-none overflow-y-auto border-0 px-1 py-1 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !archived) {
                sendMutation.mutate(draft.trim());
              }
            }}
          />
          <div className="flex items-center justify-between gap-2 pt-1.5">
            <span className="text-muted-foreground hidden font-mono text-xs sm:inline">⌘/Ctrl + Enter 发送</span>
            <div className="flex items-center gap-2">
              {interruptible ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={interruptMutation.isPending}
                  onClick={() => interruptMutation.mutate()}
                >
                  <Ban /> {interruptMutation.isPending ? "打断中…" : "打断"}
                </Button>
              ) : null}
              <Button
                size="sm"
                disabled={archived || !draft.trim() || sendMutation.isPending}
                onClick={() => sendMutation.mutate(draft.trim())}
              >
                <Send /> {sendMutation.isPending ? "发送中…" : "发送"}
              </Button>
            </div>
          </div>
          {sendMutation.isError ? (
            <p className="text-destructive pt-2 text-sm">{(sendMutation.error as Error).message}</p>
          ) : null}
        </div>
      </TabsContent>

      {/* 移动端事件详情弹窗(桌面端用右栏 aside),仅小屏挂载避免遮罩压暗页面 */}
      {!isDesktop ? (
        <Dialog open={selectedEvent !== null} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
          <DialogContent className="max-h-[85svh] overflow-x-hidden overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>事件详情</DialogTitle>
              <DialogDescription className="sr-only">查看事件载荷与元信息</DialogDescription>
            </DialogHeader>
            {selectedEvent ? <EventDetailPanel event={selectedEvent} duration={selectedDuration} /> : null}
          </DialogContent>
        </Dialog>
      ) : null}

      <TabsContent value="usage" className="flex flex-col gap-4">
        <UsageSection session={session} />
      </TabsContent>

      <TabsContent value="files" className="flex flex-col">
        <ResourcesSection sessionId={session.id} archived={archived} />
      </TabsContent>
    </Tabs>
  );
}
