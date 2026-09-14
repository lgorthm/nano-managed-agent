import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, GlmModelId, ModelEffort } from "@nano/shared/glm";
import { Bot, Plus } from "lucide-react";
import { Link } from "react-router";
import { createAgent, listAgents } from "@/api/agents";
import { DataPager } from "@/components/data-pager";
import { useCursorPage } from "@/hooks/use-cursor-page";
import { TableCard } from "@/components/table-card";
import { QueryError } from "@/components/query-error";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RefreshButton } from "@/components/refresh-button";
import { StatusBadge } from "@/components/status-badges";
import { TableSkeleton } from "@/components/table-skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatTime, formatTimeShort } from "@/lib/format";
import { useState } from "react";

function CreateAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [model, setModel] = useState<GlmModelId>("glm-5.3");
  const [effort, setEffort] = useState<ModelEffort>("max");
  const [system, setSystem] = useState("");
  const [withToolset, setWithToolset] = useState(true);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      createAgent({
        name: name.trim(),
        model: { id: model, effort },
        system: system.trim() || null,
        tools: withToolset ? [{ type: "agent_toolset_20260601" }] : [],
      }),
    onSuccess: () => {
      onOpenChange(false);
      setName("");
      setSystem("");
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> 新建 Agent
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建 Agent</DialogTitle>
          <DialogDescription>创建后生成首个不可变版本,版本从 1 开始。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="agent-name">名称</Label>
            <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="support-agent" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>模型</Label>
              <Select value={model} onValueChange={(v) => setModel(v as GlmModelId)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="glm-5.3">glm-5.3</SelectItem>
                  <SelectItem value="glm-5.3-flash">glm-5.3-flash</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>推理强度</Label>
              <Select value={effort} onValueChange={(v) => setEffort(v as ModelEffort)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="max">max</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-system">系统提示词</Label>
            <Textarea
              id="agent-system"
              rows={4}
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="You are a helpful coding agent."
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={withToolset} onCheckedChange={(v) => setWithToolset(v === true)} />
            启用内置工具集 agent_toolset_20260601
          </label>
        </div>
        {mutation.isError ? (
          <p className="text-destructive text-sm">{(mutation.error as Error).message}</p>
        ) : null}
        <DialogFooter>
          <Button disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PAGE_SIZE = 20;

export function AgentListPage() {
  const pager = useCursorPage();
  const query = useQuery({
    queryKey: ["agents", pager.cursor],
    queryFn: () => listAgents({ limit: PAGE_SIZE, ...(pager.cursor ? { page: pager.cursor } : {}) }),
    placeholderData: keepPreviousData,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const agents = query.data?.data ?? [];
  const hasNext = query.data?.next_page != null;

  return (
    <div className="flex flex-1 flex-col">
      <title>nano console — Agents</title>
      <PageHeader
        title="Agents"
        description="可复用、带版本的 Agent 配置:模型、系统提示词、工具、MCP 与 Skills。"
        actions={
          <>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
          </>
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : agents.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Bot}
            title="还没有 Agent"
            description="创建第一个 Agent:选定模型、写好系统提示词,之后所有会话和 Deployment 都从这里引用。"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> 新建 Agent
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
                <TableHead className="hidden md:table-cell">模型</TableHead>
                <TableHead className="hidden md:table-cell">版本</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((agent: Agent) => (
                <TableRow key={agent.id}>
                  <TableCell>
                    <Link
                      to={`/agents/${agent.id}`}
                      className="inline-block max-w-28 truncate font-medium hover:underline md:max-w-none"
                    >
                      {agent.name}
                    </Link>
                    <div className="text-muted-foreground hidden font-mono text-xs md:block">
                      {agent.id}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <span className="text-muted-foreground font-mono text-xs">
                      {agent.model.id}
                      {agent.model.effort ? ` · ${agent.model.effort}` : ""}
                    </span>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs tabular-nums md:table-cell">v{agent.version}</TableCell>
                  <TableCell>
                    {agent.archived_at ? (
                      <StatusBadge tint="tint-neutral">archived</StatusBadge>
                    ) : (
                      <StatusBadge tint="tint-positive">active</StatusBadge>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums sm:hidden">{formatTimeShort(agent.updated_at)}</span>
                    <span className="hidden text-sm tabular-nums sm:inline">{formatTime(agent.updated_at)}</span>
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
