import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Environment } from "@nano/shared/glm";
import { Archive, Container, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { archiveEnvironment, deleteEnvironment, getEnvironment } from "@/api/environments";
import { BackLink } from "@/components/back-link";
import { EmptyState } from "@/components/empty-state";
import { UpdateEnvironmentDialog } from "@/components/environment-form-dialog";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { SectionCard, KeyValueRow } from "@/components/section-card";
import { TableSkeleton } from "@/components/table-skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { formatTime } from "@/lib/format";

const PACKAGE_MANAGERS = ["apt", "cargo", "gem", "go", "npm", "pip"] as const;

/** 归档不可逆(无恢复接口):阻止新绑定,仍引用的会话在下一次消费环境的交互时被终止 */
function ArchiveEnvironmentDialog({ environment }: { environment: Environment }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => archiveEnvironment(environment.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["environments"] });
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
          <DialogTitle>归档 Environment?</DialogTitle>
          <DialogDescription>
            归档后不能再绑定到新的会话或部署,且无法恢复;仍引用它的会话在下一次消费环境的交互时会被终止。
          </DialogDescription>
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

/** 删除不做引用计数:引用方在下一次使用时才得到 not found,删除前需自行确认没有活跃引用 */
function DeleteEnvironmentDialog({ environment }: { environment: Environment }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => deleteEnvironment(environment.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["environments"] });
      void navigate("/environments");
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button size="sm" variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
        <Trash2 /> 删除
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 Environment?</DialogTitle>
          <DialogDescription>
            永久删除且不做引用计数:引用方在下一次使用时才会得到 not found,定时部署的下一次触发会在创建会话阶段失败。删除前请确认没有活跃引用。
          </DialogDescription>
        </DialogHeader>
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="destructive" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "删除中…" : "确认删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NetworkingSection({ environment }: { environment: Environment }) {
  const networking = environment.config.networking;
  if (networking.type === "unrestricted") {
    return (
      <SectionCard title="网络策略">
        <div className="space-y-2.5">
          <KeyValueRow label="类型">
            <Badge variant="outline" className="font-mono text-xs font-normal">
              unrestricted
            </Badge>
          </KeyValueRow>
          <p className="text-muted-foreground text-sm">沙箱可自由出网,不限制目标主机。</p>
        </div>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="网络策略">
      <div className="space-y-2.5">
        <KeyValueRow label="类型">
          <Badge variant="outline" className="font-mono text-xs font-normal">
            limited
          </Badge>
        </KeyValueRow>
        <KeyValueRow label="包管理器联网">
          <span className={networking.allow_package_managers ? "" : "text-muted-foreground"}>
            {networking.allow_package_managers ? "允许" : "禁止"}
          </span>
        </KeyValueRow>
        <KeyValueRow label="MCP 联网">
          <span className={networking.allow_mcp_servers ? "" : "text-muted-foreground"}>
            {networking.allow_mcp_servers ? "允许" : "禁止"}
          </span>
        </KeyValueRow>
        <div className="text-sm">
          <div className="text-muted-foreground mb-1.5">放行的主机({networking.allowed_hosts.length})</div>
          {networking.allowed_hosts.length === 0 ? (
            <p className="text-muted-foreground text-sm">(未放行任何主机)</p>
          ) : (
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {networking.allowed_hosts.map((host) => (
                <Badge key={host} variant="secondary" className="max-w-full font-mono text-xs font-normal">
                  <span className="truncate">{host}</span>
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

function PackagesSection({ environment }: { environment: Environment }) {
  const packages = environment.config.packages;
  const groups = PACKAGE_MANAGERS.map((manager) => ({ manager, items: packages[manager] }));
  const hasAny = groups.some(({ items }) => items.length > 0);
  return (
    <SectionCard
      title="预装软件包"
      className="md:col-span-2"
      contentClassName={hasAny ? "max-h-72 overflow-auto" : undefined}
    >
      {hasAny ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups
            .filter(({ items }) => items.length > 0)
            .map(({ manager, items }) => (
              <div key={manager} className="space-y-1.5">
                <div className="text-muted-foreground font-mono text-xs">{manager}</div>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((item) => (
                    <Badge key={item} variant="secondary" className="max-w-full font-mono text-xs font-normal">
                      <span className="truncate">{item}</span>
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          未声明额外软件包,使用云沙箱镜像的预装运行时基线(Python、Node.js 及常见 CLI 工具)。
        </p>
      )}
    </SectionCard>
  );
}

export function EnvironmentDetailPage() {
  const { environmentId } = useParams();
  const query = useQuery({
    queryKey: ["environments", environmentId],
    queryFn: () => getEnvironment(environmentId!),
    enabled: environmentId !== undefined,
  });

  if (environmentId === undefined) return null;
  if (query.isPending) return <TableSkeleton rows={4} />;
  if (query.isError) return <QueryError error={query.error} />;

  const environment = query.data;
  const metadataEntries = Object.entries(environment.metadata);

  return (
    <div className="space-y-4">
      <title>nano console — {environment.name}</title>
      <BackLink to="/environments" label="返回 Environments" />
      <PageHeader
        title={environment.name}
        description={environment.description ?? undefined}
        actions={
          <>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            {environment.state === "active" ? <UpdateEnvironmentDialog environment={environment} /> : null}
            {environment.state === "active" ? <ArchiveEnvironmentDialog environment={environment} /> : null}
            <DeleteEnvironmentDialog environment={environment} />
          </>
        }
      />

      {environment.state === "archived" ? (
        <Alert>
          <Container />
          <AlertTitle>已归档</AlertTitle>
          <AlertDescription>
            不能再绑定到新的会话或部署,且无法恢复;仍引用它的会话在下一次消费环境的交互时会被终止。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="基本信息">
          <div className="space-y-2.5">
            <KeyValueRow label="ID">
              <span className="font-mono text-xs">{environment.id}</span>
            </KeyValueRow>
            <KeyValueRow label="状态 / scope">
              <span className="font-mono text-xs">
                {environment.state} / {environment.scope}
              </span>
            </KeyValueRow>
            <KeyValueRow label="创建 / 更新">
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatTime(environment.created_at)} / {formatTime(environment.updated_at)}
              </span>
            </KeyValueRow>
            {environment.archived_at ? (
              <KeyValueRow label="归档时间">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatTime(environment.archived_at)}
                </span>
              </KeyValueRow>
            ) : null}
            {metadataEntries.length > 0 ? (
              <KeyValueRow label="metadata">
                <span className="font-mono text-xs break-all">
                  {JSON.stringify(environment.metadata)}
                </span>
              </KeyValueRow>
            ) : null}
          </div>
        </SectionCard>

        <NetworkingSection environment={environment} />
        <PackagesSection environment={environment} />
      </div>

      <div className="hidden md:block">
        <BackLink to="/environments" label="返回 Environments" desktopOnly />
      </div>
    </div>
  );
}
