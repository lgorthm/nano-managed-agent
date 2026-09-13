import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Session } from "@nano/shared/glm";
import { MessagesSquare } from "lucide-react";
import { Link } from "react-router";
import { listSessions } from "@/api/sessions";
import { DataPager } from "@/components/data-pager";
import { useCursorPage } from "@/hooks/use-cursor-page";
import { TableCard } from "@/components/table-card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { SessionCreateDialog } from "@/components/session-create-dialog";
import { SessionStatusBadge } from "@/components/status-badges";
import { TableSkeleton } from "@/components/table-skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatTime, formatTimeShort, shortId } from "@/lib/format";

const PAGE_SIZE = 20;

export function SessionListPage() {
  const pager = useCursorPage();
  const query = useQuery({
    queryKey: ["sessions", pager.cursor],
    queryFn: () => listSessions({ limit: PAGE_SIZE, ...(pager.cursor ? { page: pager.cursor } : {}) }),
    placeholderData: keepPreviousData,
  });
  const sessions = query.data?.data ?? [];
  const hasNext = query.data?.next_page != null;

  return (
    <div>
      <title>nano console — Sessions</title>
      <PageHeader
        title="Sessions"
        description="有状态的 Agent 会话:事件历史、实时流与用量。"
        actions={
          <>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            <SessionCreateDialog />
          </>
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={8} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : sessions.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={MessagesSquare}
            title="暂无会话"
            description="点右上角「新建会话」创建一个,或者由 API 调用 / Deployment 运行创建;跑起来之后,事件历史和 token 用量会出现在这里。"
          />
        </div>
      ) : (
        <TableCard>
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead className="hidden md:table-cell">Agent</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden text-right md:table-cell">Tokens (in / out)</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session: Session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    <Link
                      to={`/sessions/${session.id}`}
                      className="inline-block max-w-28 truncate font-mono text-sm hover:underline md:max-w-none"
                    >
                      {shortId(session.id)}
                    </Link>
                    {session.title ? (
                      <div className="text-muted-foreground max-w-32 truncate text-xs md:max-w-64">{session.title}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{session.agent.name}</TableCell>
                  <TableCell>
                    <SessionStatusBadge status={session.status} />
                  </TableCell>
                  <TableCell className="hidden text-right font-mono text-xs tabular-nums md:table-cell">
                    {formatNumber(session.usage.input_tokens)} / {formatNumber(session.usage.output_tokens)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums sm:hidden">{formatTimeShort(session.updated_at)}</span>
                    <span className="hidden text-sm tabular-nums sm:inline">{formatTime(session.updated_at)}</span>
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
