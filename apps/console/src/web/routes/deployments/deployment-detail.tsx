import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, Pause, Play, Zap } from "lucide-react";
import { Link, useParams } from "react-router";
import {
  getDeployment,
  listDeploymentRuns,
  pauseDeployment,
  resumeDeployment,
  runDeployment,
} from "@/api/deployments";
import { BackLink } from "@/components/back-link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { KeyValueRow, SectionCard } from "@/components/section-card";
import { DeploymentStatusBadge, StatusBadge } from "@/components/status-badges";
import { TableSkeleton } from "@/components/table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  if (deploymentQuery.isPending) return <TableSkeleton rows={4} />;
  if (deploymentQuery.isError) return <QueryError error={deploymentQuery.error} />;

  const deployment = deploymentQuery.data;
  const mutationError = (runMutation.error ?? pauseMutation.error ?? resumeMutation.error) as Error | null;

  return (
    <div className="space-y-4">
      <title>nano console — {deployment.name}</title>
      <BackLink to="/deployments" label="返回 Deployments" />
      <PageHeader
        title={deployment.name}
        description={deployment.description ?? undefined}
        actions={
          <>
            <DeploymentStatusBadge status={deployment.status} />
            {deployment.status === "active" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pauseMutation.isPending}
                onClick={() => pauseMutation.mutate()}
              >
                <Pause /> 暂停
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={resumeMutation.isPending}
                onClick={() => resumeMutation.mutate()}
              >
                <Play /> 恢复
              </Button>
            )}
            <Button size="sm" disabled={runMutation.isPending} onClick={() => runMutation.mutate()}>
              <Zap /> {runMutation.isPending ? "触发中…" : "立即运行"}
            </Button>
          </>
        }
      />

      {mutationError ? <p className="text-destructive text-sm">{mutationError.message}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="基本信息">
          <div className="space-y-2.5">
            <KeyValueRow label="ID">
              <span className="font-mono text-xs">{deployment.id}</span>
            </KeyValueRow>
            <KeyValueRow label="Agent">
              <span className="font-mono text-xs">
                {shortId(deployment.agent.id)} @ v{deployment.agent.version}
              </span>
            </KeyValueRow>
            <KeyValueRow label="Environment">
              <span className="font-mono text-xs">{shortId(deployment.environment_id)}</span>
            </KeyValueRow>
            <KeyValueRow label="创建 / 更新">
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatTime(deployment.created_at)} / {formatTime(deployment.updated_at)}
              </span>
            </KeyValueRow>
          </div>
        </SectionCard>

        <SectionCard title="调度">
          {deployment.schedule ? (
            <div className="space-y-2.5">
              <KeyValueRow label="Cron">
                <span className="font-mono text-xs">
                  {deployment.schedule.expression} ({deployment.schedule.timezone})
                </span>
              </KeyValueRow>
              <KeyValueRow label="上次运行">
                <span className="text-xs tabular-nums">{formatTime(deployment.schedule.last_run_at)}</span>
              </KeyValueRow>
              <div className="text-sm">
                <div className="text-muted-foreground mb-1.5 text-xs">下次运行</div>
                <ul className="space-y-1">
                  {deployment.schedule.upcoming_runs_at.slice(0, 3).map((t) => (
                    <li key={t} className="font-mono text-xs tabular-nums">
                      {formatTime(t)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">仅手动运行,点右上角「立即运行」触发。</p>
          )}
        </SectionCard>

        <SectionCard title="运行时注入的初始消息" className="md:col-span-2">
          <ul className="space-y-2 text-sm">
            {deployment.initial_events.map((event, i) => (
              <li key={i} className="flex gap-3 whitespace-pre-wrap">
                <span className="text-muted-foreground mt-px shrink-0 font-mono text-xs">#{i + 1}</span>
                <span className="min-w-0 leading-relaxed">
                  {event.content
                    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
                    .join("\n")}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="运行记录" className="md:col-span-2">
          {runsQuery.isPending ? (
            <TableSkeleton rows={3} />
          ) : runsQuery.isError ? (
            <QueryError error={runsQuery.error} />
          ) : runsQuery.data.data.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="暂无运行记录"
              description="点右上角「立即运行」触发一次,运行会创建会话并在这里留下记录。"
            />
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
                      <Badge variant="secondary" className="font-mono text-[11px] font-normal">
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
                        <StatusBadge tint="tint-positive">ok</StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden text-right text-xs tabular-nums md:table-cell">
                      {formatTime(run.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>

      <div className="hidden md:block">
        <BackLink to="/deployments" label="返回 Deployments" desktopOnly />
      </div>
    </div>
  );
}
