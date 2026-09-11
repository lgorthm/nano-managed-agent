import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Skill, SkillFileInput } from "@nano/shared/glm";
import { FolderInput, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { createSkill, createSkillVersion } from "@/api/skills";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBytes } from "@/lib/format";
import { collectSkillFiles, type CollectedSkillFiles } from "@/lib/skill-files";

/**
 * 目录选择字段:webkitdirectory 让浏览器整目录选取(路径在 webkitRelativePath 上),
 * 选中后本地先做与服务端一致的归一化与校验,并解析 frontmatter 供预览。
 */
function SkillFilesField({
  collected,
  error,
  onCollected,
}: {
  collected: CollectedSkillFiles | null;
  error: string | null;
  onCollected: (collected: CollectedSkillFiles | null, error: string | null) => void;
}) {
  // webkitdirectory 不在 React 类型里;重新挂 input 才能清空已选目录
  const inputKey = useRef(0);

  async function handlePick(fileList: FileList) {
    const result = await collectSkillFiles(fileList);
    inputKey.current += 1;
    if (result.ok) onCollected(result.data, null);
    else onCollected(null, result.error);
  }

  return (
    <div className="grid gap-2">
      <Label>Skill 目录</Label>
      <label className="hover:bg-muted/40 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center text-sm transition-colors hover:border-foreground/30">
        <input
          key={inputKey.current}
          type="file"
          multiple
          className="sr-only"
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            if (e.target.files?.length) void handlePick(e.target.files);
          }}
        />
        <FolderInput className="text-muted-foreground size-5" />
        {collected ? (
          <>
            <span className="text-foreground font-medium">
              {collected.files.length} 个文件 · 共 {formatBytes(collected.totalBytes)}
            </span>
            <span className="text-muted-foreground text-xs">点击重新选择</span>
          </>
        ) : (
          <>
            <span>点击选择 Skill 目录</span>
            <span className="text-muted-foreground text-xs">
              目录内需有 SKILL.md(frontmatter 提供 name 与 description)
            </span>
          </>
        )}
      </label>
      {collected?.frontmatter ? (
        <div className="bg-muted/50 rounded-md px-3 py-2 text-xs">
          <div>
            <span className="text-muted-foreground">name: </span>
            <span className="font-mono">{collected.frontmatter.name}</span>
          </div>
          <div className="text-muted-foreground mt-0.5 line-clamp-2">{collected.frontmatter.description}</div>
        </div>
      ) : null}
      {error ? <p className="text-destructive text-sm">{error}</p> : null}
    </div>
  );
}

/** 上传成功后让列表(latest_version)与详情/版本查询同时失效 */
function useSkillUploadMutation(
  upload: (files: SkillFileInput[]) => Promise<unknown>,
  onDone: () => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: upload,
    onSuccess: () => {
      // 前缀匹配同时覆盖列表(latest_version)与详情/版本查询
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      onDone();
    },
  });
}

/** 创建 Skill:目录 + 可选展示名。受控打开,列表页的空状态和页头共用。 */
export function CreateSkillDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [displayTitle, setDisplayTitle] = useState("");
  const [collected, setCollected] = useState<CollectedSkillFiles | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  function close() {
    onOpenChange(false);
    setDisplayTitle("");
    setCollected(null);
    setPickError(null);
  }

  const mutation = useSkillUploadMutation(
    (files) => createSkill({ displayTitle: displayTitle.trim() || undefined, files }),
    close,
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus /> 新建 Skill
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建 Skill</DialogTitle>
          <DialogDescription>
            上传完整 Skill 目录创建首个版本(不可变);Agent 通过 (skill_id, version) 引用固定版本。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="skill-title">展示名(可选)</Label>
            <Input
              id="skill-title"
              value={displayTitle}
              onChange={(e) => setDisplayTitle(e.target.value)}
              placeholder="PDF 工具包"
              maxLength={256}
            />
          </div>
          <SkillFilesField
            collected={collected}
            error={pickError}
            onCollected={(c, e) => {
              setCollected(c);
              setPickError(e);
            }}
          />
        </div>
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button
            disabled={!collected || mutation.isPending}
            onClick={() => collected && mutation.mutate(collected.files)}
          >
            {mutation.isPending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 上传新版本:重新上传完整目录,版本号自动递增;重复内容也不去重 */
export function UploadSkillVersionDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: Skill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [collected, setCollected] = useState<CollectedSkillFiles | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);

  function close() {
    onOpenChange(false);
    setCollected(null);
    setPickError(null);
  }

  const mutation = useSkillUploadMutation(
    (files) => createSkillVersion(skill.id, { files }),
    close,
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>上传新版本</DialogTitle>
          <DialogDescription>
            重新上传完整目录,当前 v{skill.latest_version ?? "—"} → 新版本号自动递增;已发布的版本不受影响。
          </DialogDescription>
        </DialogHeader>
        <SkillFilesField
          collected={collected}
          error={pickError}
          onCollected={(c, e) => {
            setCollected(c);
            setPickError(e);
          }}
        />
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button
            disabled={!collected || mutation.isPending}
            onClick={() => collected && mutation.mutate(collected.files)}
          >
            {mutation.isPending ? "上传中…" : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
