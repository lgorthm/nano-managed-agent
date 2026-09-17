import type { Skill } from '@nano/shared/glm';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Puzzle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { listSkills } from '@/api/skills';
import { DataPager } from '@/components/data-pager';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-error';
import { RefreshButton } from '@/components/refresh-button';
import { CreateSkillDialog } from '@/components/skill-upload-dialog';
import { TableCard } from '@/components/table-card';
import { TableSkeleton } from '@/components/table-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCursorPage } from '@/hooks/use-cursor-page';
import { formatTime, formatTimeShort } from '@/lib/format';

const PAGE_SIZE = 20;

export function SkillListPage() {
  const pager = useCursorPage();
  const query = useQuery({
    queryKey: ['skills', pager.cursor],
    queryFn: () =>
      listSkills({
        limit: PAGE_SIZE,
        ...(pager.cursor ? { page: pager.cursor } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const skills = query.data?.data ?? [];
  const hasNext = query.data?.next_page != null;

  return (
    <div className="flex flex-1 flex-col">
      <title>nano console — Skills</title>
      <PageHeader
        title="Skills"
        description="可版本化的能力包:Agent 按 (skill_id, version) 引用固定版本,版本一经发布不可变。"
        actions={
          <>
            <RefreshButton isFetching={query.isFetching} onClick={() => void query.refetch()}>
              刷新
            </RefreshButton>
            <CreateSkillDialog open={createOpen} onOpenChange={setCreateOpen} />
          </>
        }
      />
      {query.isPending ? (
        <TableSkeleton rows={6} />
      ) : query.isError ? (
        <QueryError error={query.error} />
      ) : skills.length === 0 ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Puzzle}
            title="还没有 Skill"
            description="上传一个包含 SKILL.md 的能力目录(脚本、提示词、资源),创建后即可在 Agent 配置里按版本引用。"
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> 新建 Skill
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
                <TableHead className="hidden md:table-cell">来源</TableHead>
                <TableHead>最新版本</TableHead>
                <TableHead className="hidden md:table-cell">创建时间</TableHead>
                <TableHead className="text-right">更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {skills.map((skill: Skill) => (
                <TableRow key={skill.id}>
                  <TableCell>
                    <Link
                      to={`/skills/${skill.id}`}
                      className="inline-block max-w-28 truncate font-medium hover:underline md:max-w-none"
                    >
                      {skill.display_title ?? (
                        <span className="text-muted-foreground">(未命名)</span>
                      )}
                    </Link>
                    <div className="text-muted-foreground hidden font-mono text-xs md:block">
                      {skill.id}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant="outline" className="font-mono text-xs font-normal">
                      {skill.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {skill.latest_version ? (
                      `v${skill.latest_version}`
                    ) : (
                      <span className="text-muted-foreground">空壳</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                    {formatTime(skill.created_at)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    <span className="text-xs tabular-nums sm:hidden">
                      {formatTimeShort(skill.updated_at)}
                    </span>
                    <span className="hidden text-sm tabular-nums sm:inline">
                      {formatTime(skill.updated_at)}
                    </span>
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
