import type { ManagedFile } from '@nano/shared/glm';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Files, FileUp, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { deleteFile, downloadFile, listFiles } from '@/api/files';
import { DataPager } from '@/components/data-pager';
import { EmptyState } from '@/components/empty-state';
import { FileUploadDialog } from '@/components/file-upload-dialog';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-error';
import { RefreshButton } from '@/components/refresh-button';
import { TableCard } from '@/components/table-card';
import { TableSkeleton } from '@/components/table-skeleton';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCursorPage } from '@/hooks/use-cursor-page';
import { formatBytes, formatTime, formatTimeShort, shortId } from '@/lib/format';
import { saveBlob } from '@/lib/save-blob';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

/** 下载单个文件:downloadable=false 时禁用(平台不允许下载,如生成的中间产物) */
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

/** 被会话引用等不满足删除条件时服务端会拒绝,错误信息里会给出原因 */
function DeleteFileButton({ file }: { file: ManagedFile }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => deleteFile(file.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['files'] }),
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button
        size="icon"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive size-7"
        aria-label={`删除 ${file.filename}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 {file.filename}?</DialogTitle>
          <DialogDescription>
            文件会被永久移除,不可恢复;已挂载它的会话在下一次读取时报错。
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
            onClick={() =>
              mutation.mutate(undefined, {
                onSettled: () => setOpen(false),
              })
            }
          >
            {mutation.isPending ? '删除中…' : '确认删除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FileListPage() {
  const pager = useCursorPage();
  const [scopeDraft, setScopeDraft] = useState('');
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const query = useQuery({
    queryKey: ['files', pager.cursor, scopeId],
    queryFn: () =>
      listFiles({
        limit: PAGE_SIZE,
        ...(pager.cursor ? { after_id: pager.cursor } : {}),
        ...(scopeId ? { scope_id: scopeId } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  const files = query.data?.data ?? [];
  const hasNext = query.data?.has_more === true;

  function applyScope() {
    const trimmed = scopeDraft.trim();
    setScopeId(trimmed || null);
    pager.reset();
  }

  function clearScope() {
    setScopeDraft('');
    setScopeId(null);
    pager.reset();
  }

  return (
    <div className="flex flex-1 flex-col">
      <title>nano console — Files</title>
      <PageHeader
        title="Files"
        description="托管文件库:上传的文件可作为资源挂载到会话;文件独立于会话生命周期,删除会话不影响文件。"
        actions={
          <>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            <FileUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
          </>
        }
      />
      <div className="flex items-center gap-2 pb-3">
        <Input
          value={scopeDraft}
          onChange={(e) => setScopeDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyScope();
          }}
          placeholder="按归属 Session 过滤(如 sess_…)"
          className="h-8 max-w-72 bg-card"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!scopeDraft.trim() || scopeDraft.trim() === scopeId}
          onClick={applyScope}
        >
          过滤
        </Button>
        {scopeId ? (
          <Button size="sm" variant="ghost" onClick={clearScope}>
            清除过滤
          </Button>
        ) : null}
      </div>
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : files.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={scopeId ? Files : FileUp}
            title={scopeId ? '该会话下没有文件' : '还没有文件'}
            description={
              scopeId
                ? '这个 Session scope 下暂无文件;换一个 Session ID 或清除过滤查看全部。'
                : '上传文件后,可在创建会话时把它挂载为资源,供 Agent 在沙箱内读取。'
            }
            action={
              scopeId ? undefined : (
                <Button size="sm" onClick={() => setUploadOpen(true)}>
                  <FileUp /> 上传文件
                </Button>
              )
            }
          />
        </div>
      ) : (
        <TableCard>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>文件名</TableHead>
                <TableHead className="hidden md:table-cell">大小</TableHead>
                <TableHead className="hidden md:table-cell">类型</TableHead>
                <TableHead className="hidden md:table-cell">归属 Session</TableHead>
                <TableHead className="text-right">创建时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => (
                <TableRow key={file.id}>
                  <TableCell>
                    <div
                      className="inline-block max-w-40 truncate font-medium md:max-w-none"
                      title={file.filename}
                    >
                      {file.filename}
                    </div>
                    <div className="text-muted-foreground hidden font-mono text-xs md:block">
                      {file.id}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                    {formatBytes(file.size_bytes)}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs md:table-cell">
                    <span className="line-clamp-1" title={file.mime_type}>
                      {file.mime_type}
                    </span>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {file.scope ? (
                      <Link
                        to={`/sessions/${file.scope.id}`}
                        className="text-muted-foreground font-mono text-xs hover:underline"
                      >
                        {shortId(file.scope.id)}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums sm:hidden">
                      {formatTimeShort(file.created_at)}
                    </span>
                    <span className="hidden text-sm tabular-nums sm:inline">
                      {formatTime(file.created_at)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <DownloadFileButton file={file} />
                      <DeleteFileButton file={file} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
      <DataPager
        page={pager.page}
        hasNext={hasNext}
        isFetching={query.isFetching}
        onPrev={pager.goPrev}
        onNext={() => pager.goNext(query.data?.last_id ?? null)}
      />
    </div>
  );
}
