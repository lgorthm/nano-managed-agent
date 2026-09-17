import type { Memory, MemoryPrefix } from '@nano/shared/glm';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Brain, ChevronRight, Folder, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  archiveMemoryStore,
  deleteMemoryStore,
  getMemoryStore,
  listMemories,
  listMemoryVersions,
} from '@/api/memories';
import { BackLink } from '@/components/back-link';
import { DataPager } from '@/components/data-pager';
import { EmptyState } from '@/components/empty-state';
import {
  CreateMemoryDialog,
  DeleteMemoryDialog,
  MemoryVersionDialog,
  UpdateMemoryDialog,
  ViewMemoryDialog,
} from '@/components/memory-dialogs';
import { UpdateMemoryStoreDialog } from '@/components/memory-store-form-dialog';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-error';
import { RefreshButton } from '@/components/refresh-button';
import { KeyValueRow, SectionCard } from '@/components/section-card';
import { StatusBadge } from '@/components/status-badges';
import { TableSkeleton } from '@/components/table-skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCursorPage } from '@/hooks/use-cursor-page';
import { formatBytes, formatTime } from '@/lib/format';

const MEMORY_PAGE_SIZE = 100;
const VERSION_PAGE_SIZE = 50;

/** 归档不可逆:store 无法再挂到新会话,已挂载会话在下一次访问 memory 时失败 */
function ArchiveMemoryStoreDialog({ storeId }: { storeId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => archiveMemoryStore(storeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory-stores'] });
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
          <DialogTitle>归档 Memory Store?</DialogTitle>
          <DialogDescription>
            归档后不能再挂载到新的会话或部署,且无法恢复;已挂载它的会话在下一次访问 memory
            的交互时会失败。
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

/** 删除会级联清空全部 memory 与版本历史,不可恢复 */
function DeleteMemoryStoreDialog({ storeId }: { storeId: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => deleteMemoryStore(storeId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory-stores'] });
      void navigate('/memories');
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button
        size="sm"
        variant="outline"
        className="text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 /> 删除
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 Memory Store?</DialogTitle>
          <DialogDescription>
            级联删除其中全部 memory
            与版本历史,不可恢复;挂载中的会话将读不到它。删除前请确认没有活跃引用。
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
            {mutation.isPending ? '删除中…' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 前缀面包屑:/ a / b → 点击任一段跳回该级 */
function PrefixBreadcrumb({
  prefix,
  onNavigate,
}: {
  prefix: string;
  onNavigate: (prefix: string) => void;
}) {
  const segments = prefix === '/' ? [] : prefix.replace(/^\//, '').replace(/\/$/, '').split('/');
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-xs">
      <button
        type="button"
        className="hover:bg-accent rounded px-1.5 py-0.5"
        onClick={() => onNavigate('/')}
      >
        /
      </button>
      {segments.map((segment, index) => {
        const target = `/${segments.slice(0, index + 1).join('/')}/`;
        const isLast = index === segments.length - 1;
        return (
          <span key={target} className="flex items-center">
            <button
              type="button"
              disabled={isLast}
              className="hover:bg-accent rounded px-1.5 py-0.5 disabled:font-medium disabled:hover:bg-transparent"
              onClick={() => onNavigate(target)}
            >
              {segment}
            </button>
            {!isLast ? <ChevronRight className="text-muted-foreground size-3" /> : null}
          </span>
        );
      })}
    </nav>
  );
}

export function MemoryStoreDetailPage() {
  const { memoryStoreId } = useParams();
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState('/');
  const [depth, setDepth] = useState('1');
  const [createOpen, setCreateOpen] = useState(false);
  const memoryPager = useCursorPage();
  const versionPager = useCursorPage();
  const [viewingMemory, setViewingMemory] = useState<Memory | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);
  const [versionMemoryFilter, setVersionMemoryFilter] = useState('');

  const storeQuery = useQuery({
    queryKey: ['memory-stores', memoryStoreId],
    queryFn: () => getMemoryStore(memoryStoreId!),
    enabled: memoryStoreId !== undefined,
  });
  const memoriesQuery = useQuery({
    queryKey: ['memory-stores', memoryStoreId, 'memories', prefix, depth, memoryPager.cursor],
    queryFn: () =>
      listMemories(memoryStoreId!, {
        path_prefix: prefix,
        depth: Number(depth),
        limit: MEMORY_PAGE_SIZE,
        ...(memoryPager.cursor ? { page: memoryPager.cursor } : {}),
      }),
    enabled: memoryStoreId !== undefined,
    placeholderData: keepPreviousData,
  });
  const versionsQuery = useQuery({
    queryKey: [
      'memory-stores',
      memoryStoreId,
      'memory_versions',
      versionMemoryFilter,
      versionPager.cursor,
    ],
    queryFn: () =>
      listMemoryVersions(memoryStoreId!, {
        view: 'basic',
        limit: VERSION_PAGE_SIZE,
        ...(versionMemoryFilter.trim() ? { memory_id: versionMemoryFilter.trim() } : {}),
        ...(versionPager.cursor ? { page: versionPager.cursor } : {}),
      }),
    enabled: memoryStoreId !== undefined,
    placeholderData: keepPreviousData,
  });

  if (memoryStoreId === undefined) return null;
  if (storeQuery.isPending) return <TableSkeleton rows={4} />;
  if (storeQuery.isError) return <QueryError error={storeQuery.error} />;

  const store = storeQuery.data;
  const items = memoriesQuery.data?.data ?? [];
  const prefixes = items.filter((item): item is MemoryPrefix => item.type === 'memory_prefix');
  const memories = items.filter((item): item is Memory => item.type === 'memory');
  const versions = versionsQuery.data?.data ?? [];

  const refreshAll = () =>
    void queryClient.invalidateQueries({
      queryKey: ['memory-stores', memoryStoreId],
    });

  return (
    <div className="flex flex-1 flex-col gap-4">
      <title>nano console — {store.name}</title>
      <BackLink to="/memories" label="返回 Memory Stores" />
      <PageHeader
        title={store.name}
        description={store.description || undefined}
        actions={
          <>
            <RefreshButton isFetching={storeQuery.isFetching} onClick={refreshAll}>
              刷新
            </RefreshButton>
            {!store.archived_at ? <UpdateMemoryStoreDialog store={store} /> : null}
            {!store.archived_at ? <ArchiveMemoryStoreDialog storeId={store.id} /> : null}
            <DeleteMemoryStoreDialog storeId={store.id} />
          </>
        }
      />

      {store.archived_at ? (
        <Alert>
          <Brain />
          <AlertTitle>已归档</AlertTitle>
          <AlertDescription>
            不能再挂载到新的会话或部署,且无法恢复;已挂载它的会话在下一次访问 memory 的交互时会失败。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="基本信息">
          <div className="space-y-2.5">
            <KeyValueRow label="ID">
              <span className="font-mono text-xs">{store.id}</span>
            </KeyValueRow>
            <KeyValueRow label="状态">
              <StatusBadge tint={store.archived_at ? 'tint-neutral' : 'tint-positive'}>
                {store.archived_at ? 'archived' : 'active'}
              </StatusBadge>
            </KeyValueRow>
            <KeyValueRow label="创建 / 更新">
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatTime(store.created_at)} / {formatTime(store.updated_at)}
              </span>
            </KeyValueRow>
            {Object.keys(store.metadata).length > 0 ? (
              <KeyValueRow label="metadata">
                <span className="font-mono text-xs break-all">
                  {JSON.stringify(store.metadata)}
                </span>
              </KeyValueRow>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard
          title="版本历史"
          action={
            <input
              className="border-input bg-background placeholder:text-muted-foreground h-8 w-44 rounded-md border px-2 font-mono text-xs"
              placeholder="按 memory ID 过滤"
              value={versionMemoryFilter}
              onChange={(e) => {
                setVersionMemoryFilter(e.target.value);
                versionPager.reset();
              }}
            />
          }
        >
          {versionsQuery.isPending ? (
            <TableSkeleton rows={3} />
          ) : versionsQuery.isError ? (
            <QueryError error={versionsQuery.error} />
          ) : versions.length === 0 ? (
            <p className="text-muted-foreground text-sm">暂无版本记录。</p>
          ) : (
            <div className="space-y-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>操作</TableHead>
                    <TableHead className="hidden md:table-cell">路径</TableHead>
                    <TableHead className="hidden md:table-cell">写入者</TableHead>
                    <TableHead className="text-right">时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((version) => (
                    <TableRow
                      key={version.id}
                      className="cursor-pointer"
                      onClick={() => setOpenVersionId(version.id)}
                    >
                      <TableCell>
                        <StatusBadge
                          tint={
                            version.redacted_at
                              ? 'tint-neutral'
                              : version.operation === 'deleted'
                                ? 'tint-warning'
                                : 'tint-positive'
                          }
                        >
                          {version.redacted_at ? 'redacted' : version.operation}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="hidden max-w-40 truncate font-mono text-xs md:table-cell">
                        {version.path ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                        {version.created_by.type === 'session_actor' ? 'session' : 'user'}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                        {formatTime(version.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <DataPager
                page={versionPager.page}
                hasNext={versionsQuery.data?.next_page != null}
                isFetching={versionsQuery.isFetching}
                onPrev={versionPager.goPrev}
                onNext={() => versionPager.goNext(versionsQuery.data?.next_page ?? null)}
              />
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Memory 条目"
          className="md:col-span-2"
          action={
            store.archived_at ? null : (
              <CreateMemoryDialog
                storeId={store.id}
                defaultPrefix={prefix}
                open={createOpen}
                onOpenChange={setCreateOpen}
              />
            )
          }
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <PrefixBreadcrumb
              prefix={prefix}
              onNavigate={(next) => {
                setPrefix(next);
                memoryPager.reset();
              }}
            />
            <Select
              value={depth}
              onValueChange={(v) => {
                setDepth(v);
                memoryPager.reset();
              }}
            >
              <SelectTrigger size="sm" className="ml-auto w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">仅下一级</SelectItem>
                <SelectItem value="2">下两级</SelectItem>
                <SelectItem value="1024">全部层级</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {memoriesQuery.isPending ? (
            <TableSkeleton rows={4} />
          ) : memoriesQuery.isError ? (
            <QueryError error={memoriesQuery.error} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={Brain}
              title="此处还没有 memory"
              description="用「写入 Memory」创建第一条;挂载到会话后 Agent 也会往里写。"
            />
          ) : (
            <div className="space-y-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>路径</TableHead>
                    <TableHead className="hidden md:table-cell">大小</TableHead>
                    <TableHead className="text-right">更新时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prefixes.map((item) => (
                    <TableRow
                      key={item.path}
                      className="cursor-pointer"
                      onClick={() => {
                        setPrefix(item.path);
                        memoryPager.reset();
                      }}
                    >
                      <TableCell className="font-mono text-xs">
                        <span className="flex items-center gap-1.5">
                          <Folder className="text-muted-foreground size-3.5 shrink-0" />
                          <span className="truncate">{item.path}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-xs md:table-cell">
                        目录
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs">—</TableCell>
                      <TableCell />
                    </TableRow>
                  ))}
                  {memories.map((memory) => (
                    <TableRow key={memory.id}>
                      <TableCell className="max-w-52 font-mono text-xs md:max-w-none">
                        <button
                          type="button"
                          className="hover:underline"
                          onClick={() => setViewingMemory(memory)}
                        >
                          {memory.path}
                        </button>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-xs tabular-nums md:table-cell">
                        {formatBytes(memory.content_size_bytes)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                        {formatTime(memory.updated_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setViewingMemory(memory)}
                          >
                            查看
                          </Button>
                          {!store.archived_at ? (
                            <UpdateMemoryDialog storeId={store.id} memory={memory} />
                          ) : null}
                          {!store.archived_at ? (
                            <DeleteMemoryDialog
                              storeId={store.id}
                              memory={memory}
                              onError={setRowError}
                            />
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {rowError ? <p className="text-destructive text-sm">{rowError}</p> : null}
              <DataPager
                page={memoryPager.page}
                hasNext={memoriesQuery.data?.next_page != null}
                isFetching={memoriesQuery.isFetching}
                onPrev={memoryPager.goPrev}
                onNext={() => memoryPager.goNext(memoriesQuery.data?.next_page ?? null)}
              />
            </div>
          )}
        </SectionCard>
      </div>

      <ViewMemoryDialog
        storeId={store.id}
        memoryId={viewingMemory?.id ?? ''}
        path={viewingMemory?.path ?? ''}
        open={viewingMemory !== null}
        onOpenChange={(open) => {
          if (!open) setViewingMemory(null);
        }}
      />
      <MemoryVersionDialog
        storeId={store.id}
        versionId={openVersionId}
        open={openVersionId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOpenVersionId(null);
            refreshAll();
          }
        }}
      />

      <div className="hidden md:block">
        <BackLink to="/memories" label="返回 Memory Stores" desktopOnly />
      </div>
    </div>
  );
}
