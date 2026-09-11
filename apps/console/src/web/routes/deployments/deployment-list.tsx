import { useQuery } from "@tanstack/react-query";
import type { Deployment } from "@nano/shared/glm";
import { CalendarClock } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { listDeployments } from "@/api/deployments";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { DeploymentStatusBadge } from "@/components/status-badges";
import { TableSkeleton } from "@/components/table-skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime, formatTimeShort } from "@/lib/format";

export function DeploymentListPage() {
  const query = useQuery({ queryKey: ["deployments"], queryFn: () => listDeployments({ limit: 50 }) });
  const navigate = useNavigate();
  const deployments = query.data?.data ?? [];

  return (
    <div>
      <title>nano console — Deployments</title>
      <PageHeader
        title="Deployments"
        description="定时或手动运行的 Deployment 及其运行记录。"
        actions={
          <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
            刷新
          </RefreshButton>
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
            description="Deployment 把某个版本的 Agent 按 cron 定时跑起来;通过 API 创建后,运行记录会出现在这里。"
          />
        </div>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
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
                <TableRow
                  key={deployment.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/deployments/${deployment.id}`)}
                >
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
                    {deployment.schedule ? deployment.schedule.expression : <span className="text-muted-foreground">仅手动</span>}
                  </TableCell>
                  <TableCell>
                    <DeploymentStatusBadge status={deployment.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                    {formatTime(deployment.schedule?.last_run_at)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums sm:hidden">{formatTimeShort(deployment.updated_at)}</span>
                    <span className="hidden text-sm tabular-nums sm:inline">{formatTime(deployment.updated_at)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
