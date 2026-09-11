import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Brain, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { listMemoryStores } from "@/api/memories";
import { CreateMemoryStoreDialog } from "@/components/memory-store-form-dialog";
import { DataPager } from "@/components/data-pager";
import { useCursorPage } from "@/hooks/use-cursor-page";
import { TableCard } from "@/components/table-card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { StatusBadge } from "@/components/status-badges";
import { TableSkeleton } from "@/components/table-skeleton";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime } from "@/lib/format";

const PAGE_SIZE = 20;

export function MemoryStoreListPage() {
  const pager = useCursorPage();
  const [includeArchived, setIncludeArchived] = useState(false);
  const query = useQuery({
    queryKey: ["memory-stores", pager.cursor, includeArchived],
    queryFn: () =>
      listMemoryStores({
        limit: PAGE_SIZE,
        include_archived: includeArchived || undefined,
        ...(pager.cursor ? { page: pager.cursor } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const stores = query.data?.data ?? [];
  const hasNext = query.data?.next_page != null;

  return (
    <div>
      <title>nano console — Memory Stores</title>
      <PageHeader
        title="Memory Stores"
        description="Agent 的长期记忆库:会话按路径读写 memory,平台为每次写入保留可审计的版本历史。"
        actions={
          <>
            <Label className="text-muted-foreground flex items-center gap-2 text-sm font-normal">
              <Switch checked={includeArchived} onCheckedChange={setIncludeArchived} />
              含已归档
            </Label>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            <CreateMemoryStoreDialog open={createOpen} onOpenChange={setCreateOpen} />
          </>
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : stores.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Brain}
            title="还没有 Memory Store"
            description="创建一个记忆库并挂载到会话,Agent 就能把跨会话要长期记住的知识写进来。"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> 新建 Memory Store
              </Button>
            }
          />
        </div>
      ) : (
        <TableCard>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead className="hidden md:table-cell">描述</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden md:table-cell">创建时间</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stores.map((store) => (
                <TableRow key={store.id}>
                  <TableCell>
                    <Link
                      to={`/memories/${store.id}`}
                      className="inline-block max-w-28 truncate font-medium hover:underline md:max-w-none"
                    >
                      {store.name}
                    </Link>
                    <div className="text-muted-foreground hidden font-mono text-xs md:block">{store.id}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-64 truncate text-sm md:table-cell">
                    {store.description || "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tint={store.archived_at ? "tint-neutral" : "tint-positive"}>
                      {store.archived_at ? "archived" : "active"}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                    {formatTime(store.created_at)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums">{formatTime(store.updated_at)}</span>
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
        onNext={() => pager.goNext(query.data?.next_page ?? null)}
      />
    </div>
  );
}
