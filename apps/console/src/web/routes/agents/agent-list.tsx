import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent, GlmModelId, ModelEffort } from "@nano/shared/glm";
import { Archive, Plus, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { createAgent, listAgents } from "@/api/agents";
import { QueryError } from "@/components/query-error";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatTime, formatTimeShort } from "@/lib/format";
import { useState } from "react";

function CreateAgentDialog() {
  const [open, setOpen] = useState(false);
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
      setOpen(false);
      setName("");
      setSystem("");
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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

export function AgentListPage() {
  const query = useQuery({ queryKey: ["agents"], queryFn: () => listAgents() });
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        title="Agents"
        description="可复用、带版本的 Agent 配置:模型、系统提示词、工具、MCP 与 Skills。"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              <RefreshCw /> 刷新
            </Button>
            <CreateAgentDialog />
          </>
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
                <TableHead className="hidden md:table-cell">模型</TableHead>
                <TableHead className="hidden md:table-cell">版本</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.data.data.map((agent: Agent) => (
                <TableRow
                  key={agent.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/agents/${agent.id}`)}
                >
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
                    <Badge variant="secondary" className="font-normal">
                      {agent.model.id}
                      {agent.model.effort ? ` · ${agent.model.effort}` : ""}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">v{agent.version}</TableCell>
                  <TableCell>
                    {agent.archived_at ? (
                      <Badge variant="outline" className="font-normal text-muted-foreground">
                        <Archive /> archived
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-emerald-100 font-normal text-emerald-700">
                        active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="text-xs sm:hidden">{formatTimeShort(agent.updated_at)}</span>
                    <span className="hidden sm:inline">{formatTime(agent.updated_at)}</span>
                  </TableCell>
                </TableRow>
              ))}
              {query.data.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground h-24 text-center">
                    还没有 Agent,点右上角「新建 Agent」创建第一个。
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
