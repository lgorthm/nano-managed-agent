import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import {
  getDeployment,
  listDeploymentRuns,
  pauseDeployment,
  resumeDeployment,
  runDeployment,
} from "@/api/deployments";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { DeploymentStatusBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime, shortId } from "@/lib/format";

export function DeploymentDetailPage() {
  const { deploymentId } = useParams();
  const queryClient = useQueryClient();
  const deploymentQuery = useQuery({
    queryKey: ["deployments", deploymentId],
    queryFn: () => getDeployment(deploymentId!),
    enabled: deploymentId !== undefined,
  });
  const runsQuery = useQuery({
    queryKey: ["deployments", deploymentId, "runs"],
    queryFn: () => listDeploymentRuns({ deployment_id: deploymentId!, order: "desc", limit: 50 }),
    enabled: deploymentId !== undefined,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["deployments"] });
  };
  const runMutation = useMutation({ mutationFn: () => runDeployment(deploymentId!), onSuccess: invalidate });
  const pauseMutation = useMutation({ mutationFn: () => pauseDeployment(deploymentId!), onSuccess: invalidate });
  const resumeMutation = useMutation({ mutationFn: () => resumeDeployment(deploymentId!), onSuccess: invalidate });

  if (deploymentId === undefined) return null;
  if (deploymentQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (deploymentQuery.isError) return <QueryError error={deploymentQuery.error} />;

  const deployment = deploymentQuery.data;
  const mutationError = (runMutation.error ?? pauseMutation.error ?? resumeMutation.error) as Error | null;

  return (
    <div className="space-y-4">
      <Link to="/deployments" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline md:hidden">
        ← 返回 Deployments
      </Link>
      <PageHeader
        title={deployment.name}
        description={deployment.description ?? undefined}
        actions={
          <>
            <DeploymentStatusBadge status={deployment.status} />
            {deployment.status === "active" ? (
              <Button size="sm" variant="outline" disabled={pauseMutation.isPending} onClick={() => pauseMutation.mutate()}>
                暂停
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={resumeMutation.isPending} onClick={() => resumeMutation.mutate()}>
                恢复
              </Button>
            )}
            <Button size="sm" disabled={runMutation.isPending} onClick={() => runMutation.mutate()}>
              {runMutation.isPending ? "触发中…" : "立即运行"}
            </Button>
          </>
        }
      />

      {mutationError ? <p className="text-destructive text-sm">{mutationError.message}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">基本信息</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">ID</span>
              <span className="font-mono text-xs">{deployment.id}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Agent</span>
              <span className="font-mono text-xs">
                {shortId(deployment.agent.id)} @ v{deployment.agent.version}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Environment</span>
              <span className="font-mono text-xs">{shortId(deployment.environment_id)}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">创建 / 更新</span>
              <span>
                {formatTime(deployment.created_at)} / {formatTime(deployment.updated_at)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">调度</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {deployment.schedule ? (
              <>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">Cron</span>
                  <span className="font-mono">
                    {deployment.schedule.expression} ({deployment.schedule.timezone})
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">上次运行</span>
                  <span>{formatTime(deployment.schedule.last_run_at)}</span>
                </div>
                <div>
                  <div className="text-muted-foreground mb-1 text-xs">下次运行</div>
                  <ul className="space-y-0.5">
                    {deployment.schedule.upcoming_runs_at.slice(0, 3).map((t) => (
                      <li key={t} className="font-mono text-xs">
                        {formatTime(t)}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : (
              <span className="text-muted-foreground">仅手动运行</span>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">运行时注入的初始消息</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {deployment.initial_events.map((event, i) => (
                <li key={i} className="whitespace-pre-wrap">
                  <span className="text-muted-foreground mr-2 font-mono text-xs">#{i + 1}</span>
                  {event.content
                    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
                    .join("\n")}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">运行记录</CardTitle>
          </CardHeader>
          <CardContent>
            {runsQuery.isPending ? (
              <Skeleton className="h-20 w-full" />
            ) : runsQuery.isError ? (
              <QueryError error={runsQuery.error} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead className="hidden md:table-cell">触发</TableHead>
                    <TableHead>Session</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead className="hidden text-right md:table-cell">时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runsQuery.data.data.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="max-w-24 truncate font-mono text-xs md:max-w-none">{shortId(run.id)}</TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="secondary" className="font-normal">
                          {run.trigger_context.type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {run.session_id ? (
                          <Link
                            to={`/sessions/${run.session_id}`}
                            className="inline-block max-w-24 truncate font-mono text-xs hover:underline md:max-w-none"
                          >
                            {shortId(run.session_id)}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {run.error ? (
                          <Badge variant="destructive" className="font-normal">
                            {run.error.type}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-emerald-100 font-normal text-emerald-700">
                            ok
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-right md:table-cell">{formatTime(run.created_at)}</TableCell>
                    </TableRow>
                  ))}
                  {runsQuery.data.data.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground h-24 text-center">
                        暂无运行记录,点「立即运行」触发一次。
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="hidden md:block">
        <Link to="/deployments" className="text-muted-foreground text-sm hover:underline">
          ← 返回 Deployments
        </Link>
      </div>
    </div>
  );
}
