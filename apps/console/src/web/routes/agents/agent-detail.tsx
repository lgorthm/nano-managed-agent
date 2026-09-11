import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolsetResponse } from "@nano/shared/glm";
import { Archive } from "lucide-react";
import { useParams } from "react-router";
import { archiveAgent, getAgent, listAgentVersions } from "@/api/agents";
import { BackLink } from "@/components/back-link";
import { ArchiveAgentDialog } from "@/components/archive-agent-dialog";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { KeyValueRow, SectionCard } from "@/components/section-card";
import { StatusBadge } from "@/components/status-badges";
import { TableSkeleton } from "@/components/table-skeleton";
import { UpdateAgentDialog } from "@/components/update-agent-dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime } from "@/lib/format";

function ToolsetList({ toolsets }: { toolsets: ToolsetResponse[] }) {
  if (toolsets.length === 0) return <span className="text-muted-foreground text-sm">无</span>;
  return (
    <ul className="space-y-1.5 text-sm">
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
  if (agentQuery.isPending) return <TableSkeleton rows={4} />;
  if (agentQuery.isError) return <QueryError error={agentQuery.error} />;

  const agent = agentQuery.data;

  return (
    <div className="space-y-4">
      <title>nano console — {agent.name}</title>
      <BackLink to="/agents" label="返回 Agents" />
      <PageHeader
        title={agent.name}
        description={agent.description ?? undefined}
        actions={
          agent.archived_at ? (
            <StatusBadge tint="tint-neutral">archived</StatusBadge>
          ) : (
            <>
              <UpdateAgentDialog agent={agent} />
              <ArchiveAgentDialog
                agentName={agent.name}
                pending={archiveMutation.isPending}
                error={archiveMutation.isError ? (archiveMutation.error as Error).message : null}
                onConfirm={() => archiveMutation.mutate()}
              />
            </>
          )
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="基本信息">
          <div className="space-y-2.5">
            <KeyValueRow label="ID">
              <span className="font-mono text-xs">{agent.id}</span>
            </KeyValueRow>
            <KeyValueRow label="模型">
              <span className="font-mono text-xs">
                {agent.model.id} · {agent.model.effort ?? "default"} · {agent.model.speed}
              </span>
            </KeyValueRow>
            <KeyValueRow label="当前版本">
              <span className="font-mono text-xs tabular-nums">v{agent.version}</span>
            </KeyValueRow>
            <KeyValueRow label="创建 / 更新">
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatTime(agent.created_at)} / {formatTime(agent.updated_at)}
              </span>
            </KeyValueRow>
            <KeyValueRow label="Skills / MCP">
              <span className="font-mono text-xs tabular-nums">
                {agent.skills.length} / {agent.mcp_servers.length}
              </span>
            </KeyValueRow>
          </div>
        </SectionCard>

        <SectionCard title="系统提示词" contentClassName="max-h-64 overflow-auto">
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {agent.system ?? <span className="text-muted-foreground">(未设置)</span>}
          </pre>
        </SectionCard>

        <SectionCard title="工具配置" className="md:col-span-2">
          <ToolsetList toolsets={agent.tools} />
        </SectionCard>

        <SectionCard title="版本历史" className="md:col-span-2" action={<Badge variant="outline" className="font-mono text-xs font-normal tabular-nums">{versionsQuery.data?.data.length ?? "…"} 个版本</Badge>}>
          {versionsQuery.isPending ? (
            <TableSkeleton rows={2} />
          ) : versionsQuery.isError ? (
            <QueryError error={versionsQuery.error} />
          ) : versionsQuery.data.data.length === 0 ? (
            <EmptyState icon={Archive} title="暂无版本记录" />
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
                    <TableCell className="font-mono text-xs tabular-nums">v{v.version}</TableCell>
                    <TableCell className="text-sm">{v.name}</TableCell>
                    <TableCell className="text-muted-foreground text-right text-sm tabular-nums">
                      {formatTime(v.updated_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>

      <div className="hidden md:block">
        <BackLink to="/agents" label="返回 Agents" desktopOnly />
      </div>
    </div>
  );
}
