import type { Deployment } from '@nano/shared/glm';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { listDeployments } from '@/api/deployments';
import { DataPager } from '@/components/data-pager';
import { CreateDeploymentDialog } from '@/components/deployment-form-dialog';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-error';
import { RefreshButton } from '@/components/refresh-button';
import { DeploymentStatusBadge } from '@/components/status-badges';
import { TableCard } from '@/components/table-card';
import { TableSkeleton } from '@/components/table-skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCursorPage } from '@/hooks/use-cursor-page';
import { formatTime, formatTimeShort } from '@/lib/format';

const PAGE_SIZE = 20;

export function DeploymentListPage() {
  const pager = useCursorPage();
  const [createOpen, setCreateOpen] = useState(false);
  const query = useQuery({
    queryKey: ['deployments', pager.cursor],
    queryFn: () =>
      listDeployments({
        limit: PAGE_SIZE,
        ...(pager.cursor ? { page: pager.cursor } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  const deployments = query.data?.data ?? [];
  const hasNext = query.data?.next_page != null;

  return (
    <div className="flex flex-1 flex-col">
      <title>nano console — Deployments</title>
      <PageHeader
        title="Deployments"
        description="定时或手动运行的 Deployment 及其运行记录。"
        actions={
          <>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            <CreateDeploymentDialog open={createOpen} onOpenChange={setCreateOpen} />
          </>
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : deployments.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={CalendarClock}
            title="暂无 Deployment"
            description="Deployment 把某个版本的 Agent 按 cron 定时跑起来;创建后每次运行都会在这里留下记录。"
          />
        </div>
      ) : (
        <TableCard>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead className="hidden md:table-cell">调度</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden md:table-cell">上次运行</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map((deployment: Deployment) => (
                <TableRow key={deployment.id}>
                  <TableCell>
                    <Link
                      to={`/deployments/${deployment.id}`}
                      className="inline-block max-w-28 truncate font-medium hover:underline md:max-w-none"
                    >
                      {deployment.name}
                    </Link>
                    <div className="text-muted-foreground hidden font-mono text-xs md:block">
                      {deployment.id}
                    </div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">
                    {deployment.schedule ? (
                      deployment.schedule.expression
                    ) : (
                      <span className="text-muted-foreground">仅手动</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DeploymentStatusBadge status={deployment.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                    {formatTime(deployment.schedule?.last_run_at)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums sm:hidden">
                      {formatTimeShort(deployment.updated_at)}
                    </span>
                    <span className="hidden text-sm tabular-nums sm:inline">
                      {formatTime(deployment.updated_at)}
                    </span>
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
