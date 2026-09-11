import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Memory } from "@nano/shared/glm";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import {
  createMemory,
  deleteMemory,
  getMemory,
  getMemoryVersion,
  redactMemoryVersion,
  updateMemory,
} from "@/api/memories";
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
import { Textarea } from "@/components/ui/textarea";
import { formatBytes, formatTime } from "@/lib/format";

const encoder = new TextEncoder();

/** 与服务端一致的路径校验:以 / 开头、NFC、无空段与 . / .. 段、UTF-8 ≤1024 字节 */
export function validateMemoryPath(path: string): string | null {
  if (!path.startsWith("/")) return "路径必须以 / 开头";
  if (path.normalize("NFC") !== path) return "路径必须是 NFC 规范化形式(检查是否有组合字符)";
  if (encoder.encode(path).length > 1024) return "路径 UTF-8 总长度不能超过 1024 字节";
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return "路径不能包含空段(连续 // 或以 / 结尾)";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "路径不能包含 . 或 .. 段";
  }
  return null;
}

/** 内容默认上限 102400 字节(平台可调整) */
export function validateMemoryContent(content: string): string | null {
  if (content.length === 0) return "内容不能为空;要移除条目请使用删除";
  if (encoder.encode(content).length > 102400) return "内容超过 102400 字节上限";
  return null;
}

function useMemoryMutation(submit: () => Promise<unknown>, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submit,
    onSuccess: () => {
      // 前缀匹配覆盖 store 详情、memories 与 memory_versions 列表
      void queryClient.invalidateQueries({ queryKey: ["memory-stores"] });
      onDone();
    },
  });
}

/** 新建 memory:路径决定挂载后的目录结构 */
export function CreateMemoryDialog({
  storeId,
  defaultPrefix,
  open,
  onOpenChange,
}: {
  storeId: string;
  /** 当前浏览中的前缀,作为路径默认值 */
  defaultPrefix: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [path, setPath] = useState(`${defaultPrefix === "/" ? "/" : defaultPrefix}`);
  const [content, setContent] = useState("");
  const [attempted, setAttempted] = useState(false);

  function close() {
    onOpenChange(false);
    setPath(defaultPrefix);
    setContent("");
    setAttempted(false);
  }

  const error = validateMemoryPath(path) ?? validateMemoryContent(content);
  const mutation = useMemoryMutation(
    () => createMemory(storeId, { path, content }),
    close,
  );
  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus /> 写入 Memory
      </Button>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>写入 Memory</DialogTitle>
          <DialogDescription>
            路径即知识目录,如 /team/conventions.md;同路径重复写入会生成新版本。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="create-memory-path">路径</Label>
            <Input
              id="create-memory-path"
              className="font-mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/notes/overview.md"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="create-memory-content">内容</Label>
            <Textarea
              id="create-memory-content"
              rows={10}
              className="font-mono text-xs"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="要长期记住的内容…"
            />
            <p className="text-muted-foreground text-xs">{encoder.encode(content).length} / 102400 字节</p>
          </div>
        </div>
        {attempted && error ? <p className="text-destructive text-sm">{error}</p> : null}
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={close}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => {
              setAttempted(true);
              if (!error) mutation.mutate();
            }}
          >
            {mutation.isPending ? "写入中…" : "写入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 编辑 memory:同路径写入新版本;带 content_sha256 乐观锁,冲突时拒绝 */
export function UpdateMemoryDialog({ storeId, memory }: { storeId: string; memory: Memory }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(memory.path);
  const [content, setContent] = useState(memory.content ?? "");
  const [attempted, setAttempted] = useState(false);

  function openDialog() {
    // 内容以完整视图为准(列表 basic 视图里 content 为 null)
    setPath(memory.path);
    setContent(memory.content ?? "");
    setAttempted(false);
    setOpen(true);
  }

  const error = validateMemoryPath(path) ?? validateMemoryContent(content);
  const mutation = useMemoryMutation(
    () =>
      getMemory(storeId, memory.id).then((full) =>
        updateMemory(storeId, memory.id, {
          path,
          content,
          precondition: { type: "content_sha256", content_sha256: full.content_sha256 },
        }),
      ),
    () => setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Pencil /> 编辑
      </Button>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>编辑 Memory</DialogTitle>
          <DialogDescription>
            保存会基于最新内容生成新版本;若他人已修改,会因内容哈希不一致而被拒绝。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="update-memory-path">路径</Label>
            <Input
              id="update-memory-path"
              className="font-mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="update-memory-content">内容</Label>
            <Textarea
              id="update-memory-content"
              rows={10}
              className="font-mono text-xs"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">{encoder.encode(content).length} / 102400 字节</p>
          </div>
        </div>
        {attempted && error ? <p className="text-destructive text-sm">{error}</p> : null}
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={mutation.isPending}
            onClick={() => {
              setAttempted(true);
              if (!error) mutation.mutate();
            }}
          >
            {mutation.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 只读查看 memory 内容(列表 basic 视图不含内容,按需拉全量) */
export function ViewMemoryDialog({
  storeId,
  memoryId,
  path,
  open,
  onOpenChange,
}: {
  storeId: string;
  memoryId: string;
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useQuery({
    queryKey: ["memory-stores", storeId, "memories", memoryId, "full"],
    queryFn: () => getMemory(storeId, memoryId),
    enabled: open,
  });
  const memory = query.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono break-all">{path}</DialogTitle>
          <DialogDescription>
            {memory
              ? `${formatBytes(memory.content_size_bytes)} · SHA-256 ${memory.content_sha256.slice(0, 12)}…`
              : "加载中…"}
          </DialogDescription>
        </DialogHeader>
        <pre className="bg-muted/40 max-h-96 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
          {memory?.content ?? (query.isError ? String(query.error) : "加载中…")}
        </pre>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 删除 memory:带 expected_content_sha256 乐观锁,冲突时拒绝 */
export function DeleteMemoryDialog({
  storeId,
  memory,
  onError,
}: {
  storeId: string;
  memory: Memory;
  /** 删除属于行内动作,错误冒泡给外层统一提示 */
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useMemoryMutation(
    () =>
      deleteMemory(storeId, memory.id, { expected_content_sha256: memory.content_sha256 }),
    () => setOpen(false),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onError(null);
        setOpen(next);
      }}
    >
      <Button
        size="sm"
        variant="outline"
        className="text-destructive"
        onClick={() => setOpen(true)}
      >
        删除
      </Button>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>删除 {memory.path}?</DialogTitle>
          <DialogDescription>
            永久删除该条目;版本历史会保留一条 deleted 记录。挂载中的会话将读不到它。
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

/** 查看某个不可变版本;full 视图未脱敏时可见内容,并提供脱敏动作 */
export function MemoryVersionDialog({
  storeId,
  versionId,
  open,
  onOpenChange,
}: {
  storeId: string;
  versionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [confirmRedact, setConfirmRedact] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["memory-stores", storeId, "memory_versions", versionId],
    queryFn: () => getMemoryVersion(storeId, versionId!),
    enabled: open && versionId !== null,
  });
  const version = query.data;
  const redactMutation = useMutation({
    mutationFn: () => redactMemoryVersion(storeId, versionId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["memory-stores", storeId] });
      setConfirmRedact(false);
      onOpenChange(false);
    },
  });

  function close(next: boolean) {
    setConfirmRedact(false);
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>版本详情</DialogTitle>
          <DialogDescription>
            {version
              ? `${version.operation} · ${formatTime(version.created_at)} · ${
                  version.content_size_bytes != null ? formatBytes(version.content_size_bytes) : "—"
                }`
              : "加载中…"}
          </DialogDescription>
        </DialogHeader>
        {version ? (
          <div className="grid gap-3">
            <div className="grid gap-1 text-sm">
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground shrink-0">路径</span>
                <span className="min-w-0 truncate text-right font-mono text-xs">{version.path ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground shrink-0">写入者</span>
                <span className="min-w-0 truncate text-right font-mono text-xs">
                  {version.created_by.type === "session_actor"
                    ? `session ${version.created_by.session_id}`
                    : `user ${version.created_by.user_id}`}
                </span>
              </div>
              {version.redacted_at ? (
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground shrink-0">已脱敏</span>
                  <span className="text-right text-xs tabular-nums">{formatTime(version.redacted_at)}</span>
                </div>
              ) : null}
            </div>
            <pre className="bg-muted/40 max-h-72 overflow-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap">
              {version.content ?? (version.redacted_at ? "(内容已脱敏)" : "(该版本无内容)")}
            </pre>
          </div>
        ) : query.isError ? (
          <p className="text-destructive text-sm">{String(query.error)}</p>
        ) : (
          <p className="text-muted-foreground text-sm">加载中…</p>
        )}
        {redactMutation.isError ? (
          <p className="text-destructive text-sm">{(redactMutation.error as Error).message}</p>
        ) : null}
        <DialogFooter>
          {version && !version.redacted_at && version.operation !== "deleted" ? (
            confirmRedact ? (
              <>
                <Button variant="outline" size="sm" disabled={redactMutation.isPending} onClick={() => setConfirmRedact(false)}>
                  取消
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={redactMutation.isPending}
                  onClick={() => redactMutation.mutate()}
                >
                  {redactMutation.isPending ? "脱敏中…" : "确认脱敏"}
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmRedact(true)}>
                脱敏此版本
              </Button>
            )
          ) : null}
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
