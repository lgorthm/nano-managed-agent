import { useQuery } from "@tanstack/react-query";
import type { Session } from "@nano/shared/glm";
import { RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { listSessions } from "@/api/sessions";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { SessionStatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber, formatTime, formatTimeShort, shortId } from "@/lib/format";

export function SessionListPage() {
  const query = useQuery({ queryKey: ["sessions"], queryFn: () => listSessions({ limit: 50 }) });
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        title="Sessions"
        description="有状态的 Agent 会话:事件历史、实时流与用量。"
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
                <TableHead>Session</TableHead>
                <TableHead className="hidden md:table-cell">Agent</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="hidden md:table-cell">Tokens (in/out)</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.data.map((session: Session) => (
                <TableRow
                  key={session.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/sessions/${session.id}`)}
                >
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
                  <TableCell className="hidden text-sm tabular-nums md:table-cell">
                    {formatNumber(session.usage.input_tokens)} / {formatNumber(session.usage.output_tokens)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-xs sm:hidden">{formatTimeShort(session.updated_at)}</span>
                    <span className="hidden sm:inline">{formatTime(session.updated_at)}</span>
                  </TableCell>
                </TableRow>
              ))}
              {query.data.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground h-24 text-center">
                    暂无会话。
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
