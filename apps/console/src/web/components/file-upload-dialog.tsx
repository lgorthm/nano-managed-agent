import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { uploadFile } from "@/api/files";
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
import { formatBytes } from "@/lib/format";

/**
 * 单文件选择字段:重新挂 input 才能清空已选文件;
 * multipart 的 boundary 由浏览器生成,不能手动指定 content-type。
 */
function FilePickField({
  file,
  onPick,
}: {
  file: globalThis.File | null;
  onPick: (file: globalThis.File | null) => void;
}) {
  const inputKey = useRef(0);

  return (
    <div className="grid gap-2">
      <Label htmlFor="file-input">文件</Label>
      <label
        htmlFor="file-input"
        className="hover:bg-muted/40 flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center text-sm transition-colors hover:border-foreground/30"
      >
        <input
          key={inputKey.current}
          id="file-input"
          type="file"
          className="sr-only"
          onChange={(e) => {
            onPick(e.target.files?.[0] ?? null);
            inputKey.current += 1;
          }}
        />
        <FileUp className="text-muted-foreground size-5" />
        {file ? (
          <>
            <span className="text-foreground max-w-full truncate font-medium">{file.name}</span>
            <span className="text-muted-foreground text-xs">{formatBytes(file.size)} · 点击重新选择</span>
          </>
        ) : (
          <>
            <span>点击选择要上传的文件</span>
            <span className="text-muted-foreground text-xs">大小受平台限制;上传后可作为资源挂载到会话</span>
          </>
        )}
      </label>
    </div>
  );
}

/** 上传成功后让列表与过滤结果同时失效 */
export function FileUploadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [file, setFile] = useState<globalThis.File | null>(null);
  const queryClient = useQueryClient();

  function close() {
    onOpenChange(false);
    setFile(null);
  }

  const mutation = useMutation({
    mutationFn: () => uploadFile(file!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["files"] });
      close();
    },
  });

  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : close}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus /> 上传文件
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>上传文件</DialogTitle>
          <DialogDescription>
            上传到托管文件库,供 Session 或 Deployment 作为文件资源挂载;文件独立于会话生命周期。
          </DialogDescription>
        </DialogHeader>
        <FilePickField file={file} onPick={setFile} />
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={close}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={!file || mutation.isPending}
            onClick={() => file && mutation.mutate()}
          >
            {mutation.isPending ? "上传中…" : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
