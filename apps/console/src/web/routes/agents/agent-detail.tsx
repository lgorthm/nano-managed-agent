import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolsetResponse } from "@nano/shared/glm";
import { Archive } from "lucide-react";
import { Link, useParams } from "react-router";
import { archiveAgent, getAgent, listAgentVersions } from "@/api/agents";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime } from "@/lib/format";

function ToolsetList({ toolsets }: { toolsets: ToolsetResponse[] }) {
  if (toolsets.length === 0) return <span className="text-muted-foreground text-sm">无</span>;
  return (
    <ul className="space-y-1 text-sm">
      {toolsets.map((tool, i) => (
        <li key={i} className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs font-normal">
            {tool.type === "mcp_toolset" ? `mcp:${tool.mcp_server_name}` : tool.type}
          </Badge>
          {tool.type !== "custom" && tool.default_config.enabled ? null : (
            <span className="text-muted-foreground text-xs">disabled</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AgentDetailPage() {
  const { agentId } = useParams();
  const queryClient = useQueryClient();
  const agentQuery = useQuery({
    queryKey: ["agents", agentId],
    queryFn: () => getAgent(agentId!),
    enabled: agentId !== undefined,
  });
  const versionsQuery = useQuery({
    queryKey: ["agents", agentId, "versions"],
    queryFn: () => listAgentVersions(agentId!, { order: "desc" }),
    enabled: agentId !== undefined,
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveAgent(agentId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  if (agentId === undefined) return null;
  if (agentQuery.isPending) return <Skeleton className="h-64 w-full" />;
  if (agentQuery.isError) return <QueryError error={agentQuery.error} />;

  const agent = agentQuery.data;

  return (
    <div className="space-y-4">
      <Link to="/agents" className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline md:hidden">
        ← 返回 Agents
      </Link>
      <PageHeader
        title={agent.name}
        description={agent.description ?? undefined}
        actions={
          agent.archived_at ? (
            <Badge variant="outline" className="font-normal">
              <Archive /> archived
            </Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={archiveMutation.isPending}
              onClick={() => {
                if (confirm(`归档 ${agent.name}?归档后只读,新会话不能再引用它。`)) archiveMutation.mutate();
              }}
            >
              归档
            </Button>
          )
        }
      />

      {archiveMutation.isError ? (
        <p className="text-destructive text-sm">{(archiveMutation.error as Error).message}</p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">基本信息</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">ID</span>
              <span className="font-mono text-xs">{agent.id}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">模型</span>
              <span className="font-mono text-xs">
                {agent.model.id} · {agent.model.effort ?? "default"} · {agent.model.speed}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">当前版本</span>
              <span>v{agent.version}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">创建 / 更新</span>
              <span>
                {formatTime(agent.created_at)} / {formatTime(agent.updated_at)}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Skills / MCP</span>
              <span>
                {agent.skills.length} / {agent.mcp_servers.length}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">系统提示词</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap font-mono text-xs">
              {agent.system ?? "(未设置)"}
            </pre>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">工具配置</CardTitle>
          </CardHeader>
          <CardContent>
            <ToolsetList toolsets={agent.tools} />
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">版本历史</CardTitle>
          </CardHeader>
          <CardContent>
            {versionsQuery.isPending ? (
              <Skeleton className="h-20 w-full" />
            ) : versionsQuery.isError ? (
              <QueryError error={versionsQuery.error} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>版本</TableHead>
                    <TableHead>名称</TableHead>
                    <TableHead className="text-right">时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versionsQuery.data.data.map((v) => (
                    <TableRow key={v.version}>
                      <TableCell>v{v.version}</TableCell>
                      <TableCell>{v.name}</TableCell>
                      <TableCell className="text-right">{formatTime(v.updated_at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="hidden md:block">
        <Link to="/agents" className="text-muted-foreground text-sm hover:underline">
          ← 返回 Agents
        </Link>
      </div>
    </div>
  );
}
