import type {
  ManagedFile,
  PersistedEvent,
  Session,
  SessionFileResource,
  SessionResourceResponse,
  StreamEvent,
} from '@nano/shared/glm';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Check, Copy, Download, Paperclip, Unlink } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { downloadFile, listFiles } from '@/api/files';
import {
  addSessionFileResource,
  archiveSession,
  deleteSessionFileResource,
  getSession,
  listSessionResources,
  sendSessionEvents,
} from '@/api/sessions';
import { BackLink } from '@/components/back-link';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { RefreshButton } from '@/components/refresh-button';
import { KeyValueRow, SectionCard } from '@/components/section-card';
import { SessionStatusBadge, StatusBadge } from '@/components/status-badges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSessionEvents } from '@/features/session-trace/data/use-session-events';
import { SessionTrace } from '@/features/session-trace/session-trace';
import { formatBytes, formatNumber, formatTime, shortId } from '@/lib/format';
import { saveBlob } from '@/lib/save-blob';
import { cn } from '@/lib/utils';

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
      <Download className={cn('size-3.5', mutation.isPending && 'animate-pulse')} />
    </Button>
  );
}

type EventLike = PersistedEvent | StreamEvent;

function StatCell({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="bg-card px-5 py-4">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="mt-1 font-mono text-lg font-medium tabular-nums">
        {value}
        {unit ? (
          <span className="text-muted-foreground ml-0.5 text-sm font-normal">{unit}</span>
        ) : null}
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
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
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
        {mutation.isError ? (
          <p className="text-destructive text-sm">{(mutation.error as Error).message}</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => setOpen(false)}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? '归档中…' : '确认归档'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 挂载已上传的托管文件到会话;mount_path 省略时默认 /mnt/session/uploads/{file_id} */
function AddSessionFileDialog({
  sessionId,
  disabled,
  compact = false,
}: {
  sessionId: string;
  disabled: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [fileId, setFileId] = useState('');
  const [mountPath, setMountPath] = useState('');
  const [attempted, setAttempted] = useState(false);
  const queryClient = useQueryClient();

  const filesQuery = useQuery({
    queryKey: ['files', 'for-mount'],
    queryFn: () => listFiles({ limit: 50 }),
    enabled: open,
    placeholderData: keepPreviousData,
  });
  const files = filesQuery.data?.data ?? [];

  function close() {
    setOpen(false);
    setFileId('');
    setMountPath('');
    setAttempted(false);
  }

  const mutation = useMutation({
    mutationFn: () =>
      addSessionFileResource(sessionId, {
        type: 'file',
        file_id: fileId,
        ...(mountPath.trim() ? { mount_path: mountPath.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['sessions', sessionId, 'resources'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['sessions', sessionId, 'files'],
      });
      close();
    },
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button
        type="button"
        size={compact ? 'icon-sm' : 'sm'}
        variant={compact ? 'ghost' : 'outline'}
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label="挂载文件"
        title="挂载文件"
      >
        <Paperclip data-icon="inline-start" /> {compact ? null : '挂载文件'}
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
                <SelectValue placeholder={files.length === 0 ? '暂无可选文件' : '选择文件'} />
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
        {attempted && !fileId ? (
          <p className="text-destructive text-sm">请选择要挂载的文件</p>
        ) : null}
        {mutation.isError ? (
          <p className="text-destructive text-sm">{(mutation.error as Error).message}</p>
        ) : null}
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
            {mutation.isPending ? '挂载中…' : '挂载'}
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
    mutationFn: (input: { toolUseId: string; result: 'allow' | 'deny' }) =>
      sendSessionEvents(sessionId, {
        events: [
          {
            type: 'user.tool_confirmation',
            tool_use_id: input.toolUseId,
            result: input.result,
            ...(input.result === 'deny' && reasons[input.toolUseId]?.trim()
              ? { deny_message: reasons[input.toolUseId]!.trim() }
              : {}),
          },
        ],
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', sessionId] });
      void queryClient.invalidateQueries({
        queryKey: ['sessions', sessionId, 'events'],
      });
    },
  });

  const list = [...events].reverse();
  const lastIdle = list.find(
    (event) => (event as Record<string, unknown>).type === 'session.status_idle',
  );
  const stop = (lastIdle as Record<string, unknown> | undefined)?.stop_reason as
    | { type?: string; event_ids?: string[] }
    | undefined;
  const pendingIds = stop?.type === 'requires_action' ? (stop.event_ids ?? []) : [];
  const resultIds = new Set(
    events
      .filter((event) => (event as Record<string, unknown>).type === 'agent.tool_result')
      .map((event) => (event as Record<string, unknown>).tool_use_id),
  );
  const pending = pendingIds
    .filter((id) => !resultIds.has(id))
    .map((id) => ({
      id,
      use: events.find(
        (event) => event.id === id && (event as Record<string, unknown>).type === 'agent.tool_use',
      ),
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
                value={reasons[id] ?? ''}
                onChange={(e) => setReasons((prev) => ({ ...prev, [id]: e.target.value }))}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={confirmMutation.isPending}
                  onClick={() => confirmMutation.mutate({ toolUseId: id, result: 'allow' })}
                >
                  允许
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={confirmMutation.isPending}
                  onClick={() => confirmMutation.mutate({ toolUseId: id, result: 'deny' })}
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
        {session.archived_at ? (
          <KeyValueRow label="归档时间">{formatTime(session.archived_at)}</KeyValueRow>
        ) : null}
        {session.vault_ids.length > 0 ? (
          <KeyValueRow label="Vaults">
            <span className="font-mono text-xs">
              {session.vault_ids.map((id) => shortId(id)).join(', ')}
            </span>
          </KeyValueRow>
        ) : null}
        {metadataEntries.map(([key, value]) => (
          <KeyValueRow key={key} label={key}>
            <span className="font-mono text-xs break-all">
              {typeof value === 'string' ? value : JSON.stringify(value)}
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
    queryKey: ['sessions', sessionId, 'resources'],
    queryFn: () => listSessionResources(sessionId, { limit: 200 }),
  });
  const filesQuery = useQuery({
    queryKey: ['sessions', sessionId, 'files'],
    queryFn: () => listFiles({ scope_id: sessionId, limit: 200 }),
  });
  const removeMutation = useMutation({
    mutationFn: (resourceId: string) => deleteSessionFileResource(sessionId, resourceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['sessions', sessionId, 'resources'],
      });
      void queryClient.invalidateQueries({
        queryKey: ['sessions', sessionId, 'files'],
      });
    },
  });

  const resources = resourcesQuery.data?.data ?? [];
  const fileResources = resources.filter(
    (item): item is SessionFileResource => item.type === 'file',
  );
  const mountsByFileId = new Map(fileResources.map((resource) => [resource.file_id, resource]));
  const memoryResources = resources.filter(
    (item): item is Extract<SessionResourceResponse, { type: 'memory_store' }> =>
      item.type === 'memory_store',
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
                    {resource.access === 'read_write' ? '可读写' : '只读'} · 随会话挂载,不可单独移除
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
                        <StatusBadge
                          tint="tint-positive"
                          className="font-mono text-[11px] font-normal"
                        >
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

type SessionTab = 'trace' | 'usage' | 'files';

export function SessionDetailPage() {
  const { sessionId } = useParams();
  return sessionId ? <SessionDetailContent key={sessionId} sessionId={sessionId} /> : null;
}

/** The route key isolates all local state when navigating to another session. */
function SessionDetailContent({ sessionId }: { sessionId: string }) {
  const [tab, setTab] = useState<SessionTab>('trace');
  const [live, setLive] = useState(false);
  const sessionQuery = useQuery({
    queryKey: ['sessions', sessionId],
    queryFn: () => getSession(sessionId),
  });
  const { events, eventsQuery, streamError } = useSessionEvents(sessionId, live);

  if (sessionQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (sessionQuery.isError) return <QueryError error={sessionQuery.error} />;

  const session = sessionQuery.data;
  const archived = session.archived_at !== null;

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as SessionTab)}
      className={cn(
        'session-detail-shell flex-1 flex-col',
        tab === 'trace'
          ? 'session-detail-trace absolute inset-3 md:inset-5 md:left-3'
          : 'min-h-full gap-4',
      )}
    >
      <title>nano console — {session.title ?? shortId(session.id)}</title>
      <div className="session-detail-header flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <BackLink to="/sessions" label="返回 Sessions" desktopOnly />
          <h1 className="min-w-0 truncate text-sm font-semibold">
            {session.title ?? shortId(session.id)}
          </h1>
          <span className="text-muted-foreground hidden min-w-0 truncate text-xs xl:inline">
            {session.agent.name} · {shortId(session.environment_id)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SessionStatusBadge status={session.status} />
          {!archived ? <ArchiveSessionDialog sessionId={session.id} /> : null}
          <label
            htmlFor="session-live-events"
            className="text-muted-foreground flex items-center gap-2 text-xs"
          >
            实时
            <Switch
              id="session-live-events"
              checked={live}
              onCheckedChange={setLive}
              aria-label="实时事件流"
            />
          </label>
        </div>
      </div>
      <TabsList className="session-detail-navigation">
        <TabsTrigger value="trace">轨迹</TabsTrigger>
        <TabsTrigger value="usage">Token 用量</TabsTrigger>
        <TabsTrigger value="files">会话文件</TabsTrigger>
      </TabsList>
      <TabsContent
        value="trace"
        forceMount
        className="flex min-h-0 flex-col gap-0 data-[state=inactive]:hidden"
      >
        {streamError ? (
          <p className="session-stream-error" role="status">
            {streamError}
          </p>
        ) : null}
        <div className="shrink-0">
          <PendingApprovals sessionId={session.id} archived={archived} events={events} />
        </div>
        <SessionTrace
          active={tab === 'trace'}
          session={session}
          events={events}
          loading={eventsQuery.isPending}
          error={eventsQuery.error}
          refreshing={eventsQuery.isFetching}
          onRefresh={() => {
            void eventsQuery.refetch();
          }}
          attachmentAction={
            <AddSessionFileDialog sessionId={session.id} disabled={archived} compact />
          }
        />
      </TabsContent>
      <TabsContent value="usage" className="flex flex-col gap-4">
        <UsageSection session={session} />
      </TabsContent>
      <TabsContent value="files" className="flex flex-col">
        <ResourcesSection sessionId={session.id} archived={archived} />
      </TabsContent>
    </Tabs>
  );
}
