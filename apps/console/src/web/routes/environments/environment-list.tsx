import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Environment, EnvironmentPackages } from "@nano/shared/glm";
import { Container, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { listEnvironments } from "@/api/environments";
import { DataPager } from "@/components/data-pager";
import { useCursorPage } from "@/hooks/use-cursor-page";
import { TableCard } from "@/components/table-card";
import { EmptyState } from "@/components/empty-state";
import { CreateEnvironmentDialog } from "@/components/environment-form-dialog";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { EnvironmentStateBadge, StatusBadge } from "@/components/status-badges";
import { TableSkeleton } from "@/components/table-skeleton";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime, formatTimeShort } from "@/lib/format";

const PAGE_SIZE = 20;

/** 非空包管理器摘要,如 "pip 3 · npm 1";全空返回 null */
function summarizePackages(packages: EnvironmentPackages): string | null {
  const parts = (["apt", "cargo", "gem", "go", "npm", "pip"] as const)
    .map((manager) => ({ manager, count: packages[manager].length }))
    .filter(({ count }) => count > 0)
    .map(({ manager, count }) => `${manager} ${count}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function NetworkingBadge({ environment }: { environment: Environment }) {
  const limited = environment.config.networking.type === "limited";
  return (
    <StatusBadge tint={limited ? "tint-warning" : "tint-neutral"}>
      {environment.config.networking.type}
    </StatusBadge>
  );
}

export function EnvironmentListPage() {
  const pager = useCursorPage();
  const query = useQuery({
    queryKey: ["environments", pager.cursor],
    queryFn: () =>
      listEnvironments({ limit: PAGE_SIZE, ...(pager.cursor ? { page: pager.cursor } : {}) }),
    placeholderData: keepPreviousData,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const environments = query.data?.data ?? [];
  const hasNext = query.data?.next_page != null;

  return (
    <div>
      <title>nano console — Environments</title>
      <PageHeader
        title="Environments"
        description="会话沙箱的蓝图:声明预装软件包与出网策略,创建一次即可在多个会话与部署里复用。"
        actions={
          <>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            <CreateEnvironmentDialog open={createOpen} onOpenChange={setCreateOpen} />
          </>
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : environments.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Container}
            title="还没有 Environment"
            description="默认配置(cloud + 无限制网络)开箱即用;要增装依赖或收紧出网时,再创建自定义 Environment。"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> 新建 Environment
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
                <TableHead>网络</TableHead>
                <TableHead className="hidden md:table-cell">软件包</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden md:table-cell">创建时间</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {environments.map((environment) => (
                <TableRow key={environment.id}>
                  <TableCell>
                    <Link
                      to={`/environments/${environment.id}`}
                      className="inline-block max-w-28 truncate font-medium hover:underline md:max-w-none"
                    >
                      {environment.name}
                    </Link>
                    <div className="text-muted-foreground hidden font-mono text-xs md:block">{environment.id}</div>
                  </TableCell>
                  <TableCell>
                    <NetworkingBadge environment={environment} />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden font-mono text-xs tabular-nums md:table-cell">
                    {summarizePackages(environment.config.packages) ?? "—"}
                  </TableCell>
                  <TableCell>
                    <EnvironmentStateBadge state={environment.state} />
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                    {formatTime(environment.created_at)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums sm:hidden">{formatTimeShort(environment.updated_at)}</span>
                    <span className="hidden text-sm tabular-nums sm:inline">{formatTime(environment.updated_at)}</span>
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
