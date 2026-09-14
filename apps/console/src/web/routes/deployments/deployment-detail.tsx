import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Inbox, Pause, Play, Zap } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  archiveDeployment,
  getDeployment,
  getDeploymentRun,
  listDeploymentRuns,
  pauseDeployment,
  resumeDeployment,
  runDeployment,
} from "@/api/deployments";
import { BackLink } from "@/components/back-link";
import { EmptyState } from "@/components/empty-state";
import { UpdateDeploymentDialog } from "@/components/deployment-form-dialog";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { KeyValueRow, SectionCard } from "@/components/section-card";
import { DeploymentStatusBadge, StatusBadge } from "@/components/status-badges";
import { TableSkeleton } from "@/components/table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime, shortId } from "@/lib/format";

/** 归档是幂等的终态操作:归档后不再触发调度,运行记录保留 */
function ArchiveDeploymentDialog({ deploymentId }: { deploymentId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => archiveDeployment(deploymentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      setOpen(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Archive /> 归档
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>归档 Deployment?</DialogTitle>
          <DialogDescription>归档后不再触发调度,也无法恢复;已有运行记录与会话不受影响。</DialogDescription>
        </DialogHeader>
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="destructive" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "归档中…" : "确认归档"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 单次运行详情:列表行数据不含错误信息,点开后拉全量 */
function RunDetailDialog({
  deploymentId,
  runId,
  open,
  onOpenChange,
}: {
  deploymentId: string;
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const runQuery = useQuery({
    queryKey: ["deployments", deploymentId, "runs", runId],
    queryFn: () => getDeploymentRun(runId!),
    enabled: open && runId !== null,
  });
  const run = runQuery.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>运行详情</DialogTitle>
          <DialogDescription className="font-mono">{runId}</DialogDescription>
        </DialogHeader>
        {run ? (
          <div className="space-y-2.5 text-sm">
            <KeyValueRow label="触发方式">
              <span className="font-mono text-xs">
                {run.trigger_context.type}
                {run.trigger_context.scheduled_at
                  ? ` · 计划于 ${formatTime(run.trigger_context.scheduled_at)}`
                  : ""}
              </span>
            </KeyValueRow>
            <KeyValueRow label="Agent 版本">
              <span className="font-mono text-xs">
                {shortId(run.agent.id)} @ v{run.agent.version}
              </span>
            </KeyValueRow>
            <KeyValueRow label="创建时间">
              <span className="text-xs tabular-nums">{formatTime(run.created_at)}</span>
            </KeyValueRow>
            <KeyValueRow label="会话">
              {run.session_id ? (
                <Link
                  to={`/sessions/${run.session_id}`}
                  className="font-mono text-xs hover:underline"
                  onClick={() => onOpenChange(false)}
                >
                  {run.session_id}
                </Link>
              ) : (
                <span className="text-muted-foreground text-xs">未创建(运行失败)</span>
              )}
            </KeyValueRow>
            <div className="text-sm">
              <div className="text-muted-foreground mb-1.5 text-xs">结果</div>
              {run.error ? (
                <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3">
                  <Badge variant="destructive" className="mb-1.5 font-normal">
                    {run.error.type}
                  </Badge>
                  <p className="text-destructive text-xs break-words">{run.error.message}</p>
                </div>
              ) : (
                <StatusBadge tint="tint-positive">ok</StatusBadge>
              )}
            </div>
          </div>
        ) : runQuery.isError ? (
          <p className="text-destructive text-sm">{String(runQuery.error)}</p>
        ) : (
          <p className="text-muted-foreground text-sm">加载中…</p>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeploymentDetailPage() {
  const { deploymentId } = useParams();
  const queryClient = useQueryClient();
  const [openRunId, setOpenRunId] = useState<string | null>(null);
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
    <div className="flex flex-1 flex-col gap-4">
      <title>nano console — {deployment.name}</title>
      <BackLink to="/deployments" label="返回 Deployments" />
      <PageHeader
        title={deployment.name}
        description={deployment.description ?? undefined}
        actions={
          <>
            <DeploymentStatusBadge status={deployment.status} />
            {!deployment.archived_at ? <UpdateDeploymentDialog deployment={deployment} /> : null}
            {!deployment.archived_at ? <ArchiveDeploymentDialog deploymentId={deployment.id} /> : null}
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
                  <TableRow key={run.id} className="cursor-pointer" onClick={() => setOpenRunId(run.id)}>
                    <TableCell className="max-w-24 truncate font-mono text-xs underline-offset-2 hover:underline md:max-w-none">
                      {shortId(run.id)}
                    </TableCell>
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
                          onClick={(e) => e.stopPropagation()}
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

      <RunDetailDialog
        deploymentId={deployment.id}
        runId={openRunId}
        open={openRunId !== null}
        onOpenChange={(open) => {
          if (!open) setOpenRunId(null);
        }}
      />

      <div className="hidden md:block">
        <BackLink to="/deployments" label="返回 Deployments" desktopOnly />
      </div>
    </div>
  );
}
