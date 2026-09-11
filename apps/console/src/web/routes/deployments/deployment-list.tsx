import { useQuery } from "@tanstack/react-query";
import type { Deployment } from "@nano/shared/glm";
import { RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { listDeployments } from "@/api/deployments";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { DeploymentStatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime, formatTimeShort } from "@/lib/format";

export function DeploymentListPage() {
  const query = useQuery({ queryKey: ["deployments"], queryFn: () => listDeployments({ limit: 50 }) });
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        title="Deployments"
        description="定时或手动运行的 Deployment 及其运行记录。"
        actions={
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw /> 刷新
          </Button>
        }
      />
      {query.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : (
        <div className="rounded-lg border">
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
              {query.data.data.map((deployment: Deployment) => (
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
                    {deployment.schedule ? deployment.schedule.expression : "仅手动"}
                  </TableCell>
                  <TableCell>
                    <DeploymentStatusBadge status={deployment.status} />
                  </TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{formatTime(deployment.schedule?.last_run_at)}</TableCell>
                  <TableCell className="text-right">
                    <span className="text-xs sm:hidden">{formatTimeShort(deployment.updated_at)}</span>
                    <span className="hidden sm:inline">{formatTime(deployment.updated_at)}</span>
                  </TableCell>
                </TableRow>
              ))}
              {query.data.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground h-24 text-center">
                    暂无 Deployment。
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
