import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Credential, CredentialValidation } from "@nano/shared/glm";
import { Archive, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  archiveCredential,
  archiveVault,
  deleteCredential,
  deleteVault,
  getVault,
  listCredentials,
  verifyMcpOAuth,
} from "@/api/vaults";
import { BackLink } from "@/components/back-link";
import { DataPager } from "@/components/data-pager";
import { useCursorPage } from "@/hooks/use-cursor-page";
import { EmptyState } from "@/components/empty-state";
import { CreateCredentialDialog, UpdateCredentialDialog } from "@/components/credential-form-dialog";
import { UpdateVaultDialog } from "@/components/vault-form-dialog";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { KeyValueRow, SectionCard } from "@/components/section-card";
import { StatusBadge } from "@/components/status-badges";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatTime } from "@/lib/format";

const CREDENTIAL_PAGE_SIZE = 20;

function useVaultInvalidate() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ["vaults"] });
}

function ArchiveVaultDialog({ vaultId }: { vaultId: string }) {
  const [open, setOpen] = useState(false);
  const invalidate = useVaultInvalidate();
  const mutation = useMutation({
    mutationFn: () => archiveVault(vaultId),
    onSuccess: () => {
      invalidate();
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
          <DialogTitle>归档 Vault?</DialogTitle>
          <DialogDescription>
            归档后引用它的会话与部署在下一次消费凭据的交互时会失败,且无法恢复。
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

function DeleteVaultDialog({ vaultId }: { vaultId: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const invalidate = useVaultInvalidate();
  const mutation = useMutation({
    mutationFn: () => deleteVault(vaultId),
    onSuccess: () => {
      invalidate();
      void navigate("/vaults");
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button size="sm" variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
        <Trash2 /> 删除
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 Vault?</DialogTitle>
          <DialogDescription>
            永久删除该 Vault 及其中全部凭据,不可恢复;引用它的会话在下一次使用时才会得到 not found。删除前请确认没有活跃引用。
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

/** 凭据目标地址摘要:MCP URL / host / 变量名 */
function credentialTarget(credential: Credential): string {
  const { auth } = credential;
  switch (auth.type) {
    case "mcp_oauth":
    case "static_bearer":
      return auth.mcp_server_url ?? "—";
    case "oauth":
    case "bearer":
      return auth.host ?? "—";
    case "environment_variable":
      return auth.secret_name ?? "—";
  }
}

/** MCP OAuth 凭据在线验证:探测 initialize 与 refresh,结果在弹窗中展示 */
function VerifyCredentialDialog({ vaultId, credential }: { vaultId: string; credential: Credential }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<CredentialValidation | null>(null);
  const mutation = useMutation({
    mutationFn: () => verifyMcpOAuth(vaultId, credential.id),
    onSuccess: setResult,
  });

  function start() {
    setResult(null);
    setOpen(true);
    mutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button size="sm" variant="ghost" onClick={start}>
        <ShieldCheck /> 验证
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>验证 MCP OAuth</DialogTitle>
          <DialogDescription>
            平台会向 MCP 服务器发起一次 initialize 探测,并在配置了刷新时尝试刷新令牌。
          </DialogDescription>
        </DialogHeader>
        {mutation.isPending ? (
          <p className="text-muted-foreground text-sm">验证中…</p>
        ) : mutation.isError ? (
          <p className="text-destructive text-sm">{(mutation.error as Error).message}</p>
        ) : result ? (
          <div className="grid gap-2.5 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground shrink-0">总体状态</span>
              <StatusBadge
                tint={
                  result.status === "valid"
                    ? "tint-positive"
                    : result.status === "invalid"
                      ? "tint-destructive"
                      : "tint-neutral"
                }
              >
                {result.status}
              </StatusBadge>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground shrink-0">initialize 探测</span>
              <span className="font-mono text-xs">
                {result.mcp_probe.http_response
                  ? `HTTP ${result.mcp_probe.http_response.status_code}`
                  : "无响应"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground shrink-0">刷新令牌</span>
              <span className="font-mono text-xs">
                {result.refresh.status}
                {result.refresh.http_response ? ` (HTTP ${result.refresh.http_response.status_code})` : ""}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground shrink-0">验证时间</span>
              <span className="text-xs tabular-nums">{formatTime(result.validated_at)}</span>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={start}>
            重新验证
          </Button>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteCredentialButton({ vaultId, credential }: { vaultId: string; credential: Credential }) {
  const [open, setOpen] = useState(false);
  const invalidate = useVaultInvalidate();
  const mutation = useMutation({
    mutationFn: () => deleteCredential(vaultId, credential.id),
    onSuccess: () => {
      invalidate();
      setOpen(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setOpen(true)}>
        删除
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除凭据 {credential.display_name || credential.id}?</DialogTitle>
          <DialogDescription>永久删除该凭据;引用它的会话在下一次注入时失败。</DialogDescription>
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

function ArchiveCredentialButton({ vaultId, credential }: { vaultId: string; credential: Credential }) {
  const [open, setOpen] = useState(false);
  const invalidate = useVaultInvalidate();
  const mutation = useMutation({
    mutationFn: () => archiveCredential(vaultId, credential.id),
    onSuccess: () => {
      invalidate();
      setOpen(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        归档
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>归档凭据 {credential.display_name || credential.id}?</DialogTitle>
          <DialogDescription>归档后不再注入;保留记录但无法恢复。</DialogDescription>
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

export function VaultDetailPage() {
  const { vaultId } = useParams();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const pager = useCursorPage();

  const vaultQuery = useQuery({
    queryKey: ["vaults", vaultId],
    queryFn: () => getVault(vaultId!),
    enabled: vaultId !== undefined,
  });
  const credentialsQuery = useQuery({
    queryKey: ["vaults", vaultId, "credentials", pager.cursor, includeArchived],
    queryFn: () =>
      listCredentials(vaultId!, {
        limit: CREDENTIAL_PAGE_SIZE,
        include_archived: includeArchived || undefined,
        ...(pager.cursor ? { page: pager.cursor } : {}),
      }),
    enabled: vaultId !== undefined,
    placeholderData: keepPreviousData,
  });

  if (vaultId === undefined) return null;
  if (vaultQuery.isPending) return <TableSkeleton rows={4} />;
  if (vaultQuery.isError) return <QueryError error={vaultQuery.error} />;

  const vault = vaultQuery.data;
  const credentials = credentialsQuery.data?.data ?? [];

  return (
    <div className="space-y-4">
      <title>nano console — {vault.display_name}</title>
      <BackLink to="/vaults" label="返回 Vaults" />
      <PageHeader
        title={vault.display_name}
        actions={
          <>
            <RefreshButton
              isFetching={vaultQuery.isFetching || credentialsQuery.isFetching}
              onClick={() => {
                void vaultQuery.refetch();
                void credentialsQuery.refetch();
              }}
            >
              刷新
            </RefreshButton>
            {!vault.archived_at ? <UpdateVaultDialog vault={vault} /> : null}
            {!vault.archived_at ? <ArchiveVaultDialog vaultId={vault.id} /> : null}
            <DeleteVaultDialog vaultId={vault.id} />
          </>
        }
      />

      {vault.archived_at ? (
        <Alert>
          <KeyRound />
          <AlertTitle>已归档</AlertTitle>
          <AlertDescription>引用它的会话与部署在下一次消费凭据的交互时会失败,且无法恢复。</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="基本信息">
          <div className="space-y-2.5">
            <KeyValueRow label="ID">
              <span className="font-mono text-xs">{vault.id}</span>
            </KeyValueRow>
            <KeyValueRow label="状态">
              <StatusBadge tint={vault.archived_at ? "tint-neutral" : "tint-positive"}>
                {vault.archived_at ? "archived" : "active"}
              </StatusBadge>
            </KeyValueRow>
            <KeyValueRow label="创建 / 更新">
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatTime(vault.created_at)} / {formatTime(vault.updated_at)}
              </span>
            </KeyValueRow>
            {Object.keys(vault.metadata).length > 0 ? (
              <KeyValueRow label="metadata">
                <span className="font-mono text-xs break-all">{JSON.stringify(vault.metadata)}</span>
              </KeyValueRow>
            ) : null}
          </div>
        </SectionCard>

        <SectionCard
          title="凭据"
          className="md:col-span-2"
          action={
            vault.archived_at ? null : (
              <CreateCredentialDialog vaultId={vault.id} open={createOpen} onOpenChange={setCreateOpen} />
            )
          }
        >
          <div className="mb-3 flex items-center">
            <Label className="text-muted-foreground flex items-center gap-2 text-sm font-normal">
              <Switch checked={includeArchived} onCheckedChange={(v) => { setIncludeArchived(v); pager.reset(); }} />
              含已归档
            </Label>
          </div>
          {credentialsQuery.isPending ? (
            <TableSkeleton rows={3} />
          ) : credentialsQuery.isError ? (
            <QueryError error={credentialsQuery.error} />
          ) : credentials.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="还没有凭据"
              description="添加 API token、OAuth 凭据或环境变量;会话引用此 Vault 后由平台安全注入。"
            />
          ) : (
            <div className="space-y-2">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead className="hidden md:table-cell">目标</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {credentials.map((credential) => (
                    <TableRow key={credential.id}>
                      <TableCell className="max-w-32 md:max-w-none">
                        <span className="block truncate font-medium">
                          {credential.display_name || <span className="text-muted-foreground font-mono text-xs">{credential.id}</span>}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono text-[11px] font-normal">
                          {credential.auth.type}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden max-w-56 truncate font-mono text-xs md:table-cell">
                        {credentialTarget(credential)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tint={credential.archived_at ? "tint-neutral" : "tint-positive"}>
                          {credential.archived_at ? "archived" : "active"}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {credential.auth.type === "mcp_oauth" ? (
                            <VerifyCredentialDialog vaultId={vault.id} credential={credential} />
                          ) : null}
                          {!credential.archived_at ? (
                            <UpdateCredentialDialog vaultId={vault.id} credential={credential} />
                          ) : null}
                          {!credential.archived_at ? (
                            <ArchiveCredentialButton vaultId={vault.id} credential={credential} />
                          ) : null}
                          <DeleteCredentialButton vaultId={vault.id} credential={credential} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <DataPager
                page={pager.page}
                hasNext={credentialsQuery.data?.next_page != null}
                isFetching={credentialsQuery.isFetching}
                onPrev={pager.goPrev}
                onNext={() => pager.goNext(credentialsQuery.data?.next_page ?? null)}
              />
            </div>
          )}
        </SectionCard>
      </div>

      <div className="hidden md:block">
        <BackLink to="/vaults" label="返回 Vaults" desktopOnly />
      </div>
    </div>
  );
}
