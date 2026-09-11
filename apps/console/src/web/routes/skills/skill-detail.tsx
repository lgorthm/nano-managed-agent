import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { deleteSkill, deleteSkillVersion, downloadSkillZip, getSkill, listSkillVersions } from "@/api/skills";
import { BackLink } from "@/components/back-link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RefreshButton } from "@/components/refresh-button";
import { KeyValueRow, SectionCard } from "@/components/section-card";
import { UploadSkillVersionDialog } from "@/components/skill-upload-dialog";
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
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/format";
import { saveBlob } from "@/lib/save-blob";

/** 下载某个版本的 ZIP:带文字的 outline 形态用于页头,图标形态用于版本行 */
function DownloadZipButton({
  skillId,
  version,
  directory,
  labeled = false,
}: {
  skillId: string;
  version: string;
  directory: string;
  labeled?: boolean;
}) {
  const mutation = useMutation({
    mutationFn: () => downloadSkillZip(skillId, version, `${directory}-v${version}.zip`),
    onSuccess: ({ blob, filename }) => saveBlob(blob, filename),
  });
  if (labeled) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <Download className={cn(mutation.isPending && "animate-pulse")} /> 下载 v{version}
      </Button>
    );
  }
  return (
    <Button
      size="icon"
      variant="ghost"
      className="text-muted-foreground size-7"
      aria-label={`下载 v${version} ZIP`}
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      <Download className="size-3.5" />
    </Button>
  );
}

/** 危险操作确认:被活动配置引用时服务端会拒绝,错误信息里会给出引用方 */
function DeleteSkillDialog({
  skillId,
  open,
  onOpenChange,
  onDeleted,
}: {
  skillId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => deleteSkill(skillId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      onDeleted();
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : onOpenChange}>
      <Button size="sm" variant="outline" className="text-destructive" onClick={() => onOpenChange(true)}>
        <Trash2 /> 删除
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 Skill?</DialogTitle>
          <DialogDescription>
            所有版本与文件一并删除,不可恢复。被未归档 Agent 的活动配置引用时删除会被拒绝,需先解除引用或归档 Agent。
          </DialogDescription>
        </DialogHeader>
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => onOpenChange(false)}>
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

function DeleteVersionButton({ skillId, version }: { skillId: string; version: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => deleteSkillVersion(skillId, version),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      setOpen(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : setOpen}>
      <Button
        size="icon"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive size-7"
        aria-label={`删除 v${version}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除版本 v{version}?</DialogTitle>
          <DialogDescription>
            删除最新版本时,latest_version 会回落到剩余的最大版本;没有剩余版本时 Skill 变成空壳,可继续上传新版本。
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

export function SkillDetailPage() {
  const { skillId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const skillQuery = useQuery({
    queryKey: ["skills", skillId],
    queryFn: () => getSkill(skillId!),
    enabled: skillId !== undefined,
  });
  const versionsQuery = useQuery({
    queryKey: ["skills", skillId, "versions"],
    queryFn: () => listSkillVersions(skillId!, { limit: 100, order: "desc" }),
    enabled: skillId !== undefined,
  });

  if (skillId === undefined) return null;
  if (skillQuery.isPending) return <TableSkeleton rows={4} />;
  if (skillQuery.isError) return <QueryError error={skillQuery.error} />;

  const skill = skillQuery.data;
  const versions = versionsQuery.data?.data ?? [];
  const latest = skill.latest_version ? versions.find((v) => v.version === skill.latest_version) : undefined;
  const title = skill.display_title ?? latest?.name ?? skill.id;

  return (
    <div className="space-y-4">
      <title>nano console — {title}</title>
      <BackLink to="/skills" label="返回 Skills" />
      <PageHeader
        title={title}
        description={latest?.description}
        actions={
          <>
            <RefreshButton isFetching={skillQuery.isFetching || versionsQuery.isFetching} onClick={() => {
              void skillQuery.refetch();
              void versionsQuery.refetch();
            }}>
              刷新
            </RefreshButton>
            {latest ? (
              <DownloadZipButton skillId={skill.id} version={latest.version} directory={latest.directory} labeled />
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setUploadOpen(true)}>
              <Upload /> 上传新版本
            </Button>
            <DeleteSkillDialog
              skillId={skill.id}
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
              onDeleted={() => void navigate("/skills")}
            />
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="基本信息">
          <div className="space-y-2.5">
            <KeyValueRow label="ID">
              <span className="font-mono text-xs">{skill.id}</span>
            </KeyValueRow>
            <KeyValueRow label="frontmatter name">
              <span className="font-mono text-xs">{latest?.name ?? "—"}</span>
            </KeyValueRow>
            <KeyValueRow label="来源 / 目录">
              <span className="font-mono text-xs">
                {skill.source} / {latest?.directory ?? "—"}
              </span>
            </KeyValueRow>
            <KeyValueRow label="最新版本">
              <span className="font-mono text-xs tabular-nums">
                {skill.latest_version ? `v${skill.latest_version}` : "(空壳)"}
              </span>
            </KeyValueRow>
            <KeyValueRow label="创建 / 更新">
              <span className="text-muted-foreground text-xs tabular-nums">
                {formatTime(skill.created_at)} / {formatTime(skill.updated_at)}
              </span>
            </KeyValueRow>
          </div>
        </SectionCard>

        <SectionCard
          title="最新版本描述"
          contentClassName="max-h-64 overflow-auto"
        >
          {latest ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{latest.description}</p>
          ) : (
            <span className="text-muted-foreground text-sm">
              (空壳)上传新版本后,SKILL.md frontmatter 的 description 会显示在这里。
            </span>
          )}
        </SectionCard>

        <SectionCard
          title="版本历史"
          className="md:col-span-2"
          action={
            <Badge variant="outline" className="font-mono text-xs font-normal tabular-nums">
              {versionsQuery.isPending ? "…" : `${versions.length} 个版本`}
            </Badge>
          }
          contentClassName="max-h-[28rem] overflow-auto"
        >
          {versionsQuery.isPending ? (
            <TableSkeleton rows={3} />
          ) : versionsQuery.isError ? (
            <QueryError error={versionsQuery.error} />
          ) : versions.length === 0 ? (
            <EmptyState
              icon={Upload}
              title="该 Skill 暂无版本"
              description="之前的版本已被删空;上传新版本后版本号会继续递增,不会复用旧编号。"
              action={
                <Button size="sm" onClick={() => setUploadOpen(true)}>
                  <Upload /> 上传新版本
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>版本</TableHead>
                  <TableHead>目录</TableHead>
                  <TableHead className="hidden md:table-cell">创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((version) => (
                  <TableRow key={version.version}>
                    <TableCell className="font-mono text-xs tabular-nums">
                      v{version.version}
                      {version.version === skill.latest_version ? (
                        <Badge variant="secondary" className="ml-1.5 px-1.5 text-[10px] font-normal">
                          最新
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{version.directory}</TableCell>
                    <TableCell className="text-muted-foreground hidden text-sm tabular-nums md:table-cell">
                      {formatTime(version.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <DownloadZipButton
                          skillId={skill.id}
                          version={version.version}
                          directory={version.directory}
                        />
                        <DeleteVersionButton skillId={skill.id} version={version.version} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>

      <div className="hidden md:block">
        <BackLink to="/skills" label="返回 Skills" desktopOnly />
      </div>

      <UploadSkillVersionDialog skill={skill} open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}
