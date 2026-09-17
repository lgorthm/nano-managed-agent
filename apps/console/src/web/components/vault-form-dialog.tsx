import type { Vault, VaultUpdateInput } from '@nano/shared/glm';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { createVault, updateVault } from '@/api/vaults';
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

interface VaultFormState {
  displayName: string;
}

function formFromVault(vault: Vault): VaultFormState {
  return { displayName: vault.display_name };
}

function validateForm(form: VaultFormState): string | null {
  const name = form.displayName.trim();
  if (!name) return '显示名称不能为空';
  if (name.length > 255) return '显示名称最多 255 个字符';
  return null;
}

function useVaultMutation(submit: () => Promise<unknown>, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submit,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['vaults'] });
      onDone();
    },
  });
}

/** 创建 Vault:之后在详情页往里添加凭据 */
export function CreateVaultDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<VaultFormState>({ displayName: '' });
  const [attempted, setAttempted] = useState(false);

  function close() {
    onOpenChange(false);
    setForm({ displayName: '' });
    setAttempted(false);
  }

  const error = validateForm(form);
  const mutation = useVaultMutation(
    () => createVault({ display_name: form.displayName.trim() }),
    close,
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus /> 新建 Vault
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建 Vault</DialogTitle>
          <DialogDescription>
            凭据金库:把 API token、OAuth 凭据或环境变量集中管理,会话通过 vault_ids
            引用后由平台安全注入。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="create-vault-name">显示名称</Label>
          <Input
            id="create-vault-name"
            value={form.displayName}
            onChange={(e) => setForm({ displayName: e.target.value })}
            placeholder="github-credentials"
            maxLength={255}
          />
        </div>
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

export function UpdateVaultDialog({ vault }: { vault: Vault }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<VaultFormState>(() => formFromVault(vault));
  const [attempted, setAttempted] = useState(false);

  const initial = formFromVault(vault);
  const dirty = form.displayName !== initial.displayName;
  const error = validateForm(form);

  function openDialog() {
    setForm(formFromVault(vault));
    setAttempted(false);
    setOpen(true);
  }

  const mutation = useVaultMutation(
    () => {
      const input: VaultUpdateInput = { display_name: form.displayName.trim() };
      return updateVault(vault.id, input);
    },
    () => setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Pencil /> 编辑
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑 Vault</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="update-vault-name">显示名称</Label>
          <Input
            id="update-vault-name"
            value={form.displayName}
            onChange={(e) => setForm({ displayName: e.target.value })}
            maxLength={255}
          />
        </div>
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
