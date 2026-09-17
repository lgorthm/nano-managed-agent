import type { MemoryStore, MemoryStoreUpdateInput } from '@nano/shared/glm';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { createMemoryStore, updateMemoryStore } from '@/api/memories';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface StoreFormState {
  name: string;
  description: string;
}

function formFromStore(store: MemoryStore): StoreFormState {
  return { name: store.name, description: store.description ?? '' };
}

function validateForm(form: StoreFormState): string | null {
  const name = form.name.trim();
  if (!name) return '名称不能为空';
  if (name.length > 255) return '名称最多 255 个字符';
  // 服务端拒绝控制字符与格式字符(如零宽空格)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 校验名称不得含控制/不可见字符,控制字符正是要匹配的目标
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/.test(name)) {
    return '名称不能包含控制字符或不可见格式字符';
  }
  if (form.description.length > 1024) return '描述最多 1024 个字符';
  return null;
}

function useStoreMutation(submit: () => Promise<unknown>, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submit,
    onSuccess: () => {
      // 前缀匹配同时覆盖列表与详情查询
      void queryClient.invalidateQueries({ queryKey: ['memory-stores'] });
      onDone();
    },
  });
}

function StoreFormFields({
  form,
  onChange,
  idPrefix,
}: {
  form: StoreFormState;
  onChange: (patch: Partial<StoreFormState>) => void;
  idPrefix: string;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-name`}>名称</Label>
        <Input
          id={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="project-knowledge"
          maxLength={255}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-description`}>描述</Label>
        <Textarea
          id={`${idPrefix}-description`}
          rows={3}
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="可选,用途说明;Agent 运行时能读到这段说明来判断挂载时机"
        />
      </div>
    </div>
  );
}

/** 创建 Memory Store:Agent 会话可挂载它来长期记忆跨会话的知识 */
export function CreateMemoryStoreDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<StoreFormState>({
    name: '',
    description: '',
  });
  const [attempted, setAttempted] = useState(false);

  function close() {
    onOpenChange(false);
    setForm({ name: '', description: '' });
    setAttempted(false);
  }

  const error = validateForm(form);
  const mutation = useStoreMutation(
    () =>
      createMemoryStore({
        name: form.name.trim(),
        description: form.description.trim() || null,
      }),
    close,
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus /> 新建 Memory Store
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建 Memory Store</DialogTitle>
          <DialogDescription>
            长期记忆库:挂载到会话后,Agent 可把跨会话要记住的知识按路径写入这里。
          </DialogDescription>
        </DialogHeader>
        <StoreFormFields
          form={form}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          idPrefix="create-memstore"
        />
        {attempted && error ? <p className="text-destructive text-sm">{error}</p> : null}
        {mutation.isError ? (
          <p className="text-destructive text-sm">{(mutation.error as Error).message}</p>
        ) : null}
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
            {mutation.isPending ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 编辑 Memory Store:null/省略 = 保持不变,这里两个都总是下发 */
export function UpdateMemoryStoreDialog({ store }: { store: MemoryStore }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<StoreFormState>(() => formFromStore(store));
  const [attempted, setAttempted] = useState(false);

  const initial = formFromStore(store);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const error = validateForm(form);

  function openDialog() {
    setForm(formFromStore(store));
    setAttempted(false);
    setOpen(true);
  }

  const mutation = useStoreMutation(
    () => {
      const input: MemoryStoreUpdateInput = {
        name: form.name.trim(),
        description: form.description.trim() || null,
      };
      return updateMemoryStore(store.id, input);
    },
    () => setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Pencil /> 编辑
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑 Memory Store</DialogTitle>
          <DialogDescription>修改名称与描述,不影响已写入的 memory 内容。</DialogDescription>
        </DialogHeader>
        <StoreFormFields
          form={form}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          idPrefix="update-memstore"
        />
        {attempted && error ? <p className="text-destructive text-sm">{error}</p> : null}
        {mutation.isError ? (
          <p className="text-destructive text-sm">{(mutation.error as Error).message}</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending}
            onClick={() => setOpen(false)}
          >
            取消
          </Button>
          <Button
            size="sm"
            disabled={!dirty || mutation.isPending}
            onClick={() => {
              setAttempted(true);
              if (!error) mutation.mutate();
            }}
          >
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
