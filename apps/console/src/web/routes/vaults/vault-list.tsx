import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { listVaults } from '@/api/vaults';
import { DataPager } from '@/components/data-pager';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-error';
import { RefreshButton } from '@/components/refresh-button';
import { StatusBadge } from '@/components/status-badges';
import { TableCard } from '@/components/table-card';
import { TableSkeleton } from '@/components/table-skeleton';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreateVaultDialog } from '@/components/vault-form-dialog';
import { useCursorPage } from '@/hooks/use-cursor-page';
import { formatTime } from '@/lib/format';

const PAGE_SIZE = 20;

export function VaultListPage() {
  const pager = useCursorPage();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const query = useQuery({
    queryKey: ['vaults', pager.cursor, includeArchived],
    queryFn: () =>
      listVaults({
        limit: PAGE_SIZE,
        include_archived: includeArchived || undefined,
        ...(pager.cursor ? { page: pager.cursor } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  const vaults = query.data?.data ?? [];
  const hasNext = query.data?.next_page != null;

  return (
    <div className="flex flex-1 flex-col">
      <title>nano console — Vaults</title>
      <PageHeader
        title="Vaults"
        description="凭据金库:集中保管 API token、OAuth 凭据与环境变量,会话与部署通过引用安全注入,secret 永不回显。"
        actions={
          <>
            <Label className="text-muted-foreground flex items-center gap-2 text-sm font-normal">
              <Switch checked={includeArchived} onCheckedChange={setIncludeArchived} />
              含已归档
            </Label>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            <CreateVaultDialog open={createOpen} onOpenChange={setCreateOpen} />
          </>
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : vaults.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={KeyRound}
            title="还没有 Vault"
            description="创建一个 Vault 并添加凭据,然后在会话或部署里通过 vault_ids 引用。"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> 新建 Vault
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
                <TableHead>状态</TableHead>
                <TableHead className="hidden md:table-cell">创建时间</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vaults.map((vault) => (
                <TableRow key={vault.id}>
                  <TableCell>
                    <Link
                      to={`/vaults/${vault.id}`}
                      className="inline-block max-w-28 truncate font-medium hover:underline md:max-w-none"
                    >
                      {vault.display_name}
                    </Link>
                    <div className="text-muted-foreground hidden font-mono text-xs md:block">
                      {vault.id}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tint={vault.archived_at ? 'tint-neutral' : 'tint-positive'}>
                      {vault.archived_at ? 'archived' : 'active'}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                    {formatTime(vault.created_at)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums">{formatTime(vault.updated_at)}</span>
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
