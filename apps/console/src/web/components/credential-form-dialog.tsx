import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Credential,
  CredentialAuthCreate,
  CredentialAuthUpdate,
  CredentialCreateInput,
  CredentialUpdateInput,
  VaultNetworking,
} from "@nano/shared/glm";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { createCredential, updateCredential } from "@/api/vaults";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type AuthType = CredentialAuthCreate["type"];

const AUTH_TYPE_LABEL: Record<AuthType, string> = {
  mcp_oauth: "mcp_oauth — MCP OAuth",
  static_bearer: "static_bearer — MCP 静态 Bearer",
  oauth: "oauth — 通用 OAuth",
  bearer: "bearer — Host Bearer",
  environment_variable: "environment_variable — 环境变量",
};

interface CredentialFormState {
  displayName: string;
  authType: AuthType;
  mcpServerUrl: string;
  host: string;
  accessToken: string;
  token: string;
  /** datetime-local 原值;空 = 不过期 */
  expiresAt: string;
  secretName: string;
  secretValue: string;
  networkingType: "unrestricted" | "limited";
  /** 一行一个 host */
  allowedHosts: string;
  injectHeader: boolean;
}

function blankForm(): CredentialFormState {
  return {
    displayName: "",
    authType: "static_bearer",
    mcpServerUrl: "",
    host: "",
    accessToken: "",
    token: "",
    expiresAt: "",
    secretName: "",
    secretValue: "",
    networkingType: "unrestricted",
    allowedHosts: "",
    injectHeader: true,
  };
}

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function validateHosts(hosts: string[]): string | null {
  if (hosts.length > 16) return "allowed_hosts 最多 16 项";
  for (const host of hosts) {
    if (host.includes("://")) return `host "${host}" 不能带协议前缀`;
    if (host.includes("/") || host.includes(":")) return `host "${host}" 不能带端口或路径`;
  }
  return null;
}

function validateForm(form: CredentialFormState, isCreate: boolean): string | null {
  if (form.displayName.length > 255) return "显示名称最多 255 个字符";
  // 创建时 secret 必填;编辑时留空 = 保留现有值
  const requireSecret = (value: string, label: string) =>
    isCreate && !value ? `${label}不能为空` : null;

  switch (form.authType) {
    case "mcp_oauth":
    case "static_bearer": {
      if (!form.mcpServerUrl.startsWith("https://")) return "MCP 服务器地址必须是 https:// URL";
      if (form.mcpServerUrl.includes("#")) return "MCP 服务器地址不能包含 fragment";
      if (form.mcpServerUrl.length > 2048) return "MCP 服务器地址超过 2048 字符";
      if (form.authType === "mcp_oauth") {
        const secretError = requireSecret(form.accessToken, "access_token");
        if (secretError) return secretError;
      } else {
        const secretError = requireSecret(form.token, "token");
        if (secretError) return secretError;
      }
      break;
    }
    case "oauth":
    case "bearer": {
      if (!/^https:\/\/[^/?#]+\/?$/.test(form.host)) {
        return "host 必须是 HTTPS origin(如 https://api.example.com),不带路径或 query";
      }
      if (form.authType === "oauth") {
        const secretError = requireSecret(form.accessToken, "access_token");
        if (secretError) return secretError;
      } else {
        const secretError = requireSecret(form.token, "token");
        if (secretError) return secretError;
      }
      break;
    }
    case "environment_variable": {
      const nameError = requireSecret(form.secretName, "secret_name");
      if (nameError) return nameError;
      const valueError = requireSecret(form.secretValue, "secret_value");
      if (valueError) return valueError;
      if (form.networkingType === "limited") {
        const hosts = parseLines(form.allowedHosts);
        if (hosts.length === 0) return "limited 网络下至少放行一个 host";
        const hostsError = validateHosts(hosts);
        if (hostsError) return hostsError;
      }
      break;
    }
  }
  if (form.expiresAt && Number.isNaN(new Date(form.expiresAt).getTime())) {
    return "过期时间格式不正确";
  }
  return null;
}

function buildNetworking(form: CredentialFormState): VaultNetworking {
  return form.networkingType === "unrestricted"
    ? { type: "unrestricted" }
    : { type: "limited", allowed_hosts: parseLines(form.allowedHosts) };
}

function buildAuthCreate(form: CredentialFormState): CredentialAuthCreate {
  const expiresAt = form.expiresAt ? new Date(form.expiresAt).toISOString() : null;
  switch (form.authType) {
    case "mcp_oauth":
      return {
        type: "mcp_oauth",
        mcp_server_url: form.mcpServerUrl.trim(),
        access_token: form.accessToken,
        expires_at: expiresAt,
      };
    case "static_bearer":
      return { type: "static_bearer", mcp_server_url: form.mcpServerUrl.trim(), token: form.token };
    case "oauth":
      return { type: "oauth", host: form.host.trim(), access_token: form.accessToken, expires_at: expiresAt };
    case "bearer":
      return { type: "bearer", host: form.host.trim(), token: form.token };
    case "environment_variable":
      return {
        type: "environment_variable",
        secret_name: form.secretName.trim(),
        secret_value: form.secretValue,
        networking: buildNetworking(form),
        injection_location: { header: form.injectHeader, body: false },
      };
  }
}

/** 更新只允许轮换 secret / 调整可变参数;留空的 secret 不下发 = 保留现有值 */
function buildAuthUpdate(form: CredentialFormState): CredentialAuthUpdate {
  switch (form.authType) {
    case "mcp_oauth":
      return {
        type: "mcp_oauth",
        ...(form.accessToken ? { access_token: form.accessToken } : {}),
        ...(form.expiresAt ? { expires_at: new Date(form.expiresAt).toISOString() } : {}),
      };
    case "static_bearer":
      return { type: "static_bearer", ...(form.token ? { token: form.token } : {}) };
    case "oauth":
      return {
        type: "oauth",
        ...(form.accessToken ? { access_token: form.accessToken } : {}),
        ...(form.expiresAt ? { expires_at: new Date(form.expiresAt).toISOString() } : {}),
      };
    case "bearer":
      return { type: "bearer", ...(form.token ? { token: form.token } : {}) };
    case "environment_variable":
      return {
        type: "environment_variable",
        ...(form.secretValue ? { secret_value: form.secretValue } : {}),
        networking: buildNetworking(form),
        injection_location: { header: form.injectHeader, body: false },
      };
  }
}

function CredentialFormFields({
  form,
  onChange,
  isCreate,
}: {
  form: CredentialFormState;
  onChange: (patch: Partial<CredentialFormState>) => void;
  isCreate: boolean;
}) {
  const isMcp = form.authType === "mcp_oauth" || form.authType === "static_bearer";
  const isHost = form.authType === "oauth" || form.authType === "bearer";
  const usesAccessToken = form.authType === "mcp_oauth" || form.authType === "oauth";
  const usesToken = form.authType === "static_bearer" || form.authType === "bearer";
  const usesExpires = form.authType === "mcp_oauth" || form.authType === "oauth";
  const isEnvVar = form.authType === "environment_variable";
  const idPrefix = isCreate ? "create-cred" : "update-cred";

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-display`}>显示名称(可选)</Label>
        <Input
          id={`${idPrefix}-display`}
          value={form.displayName}
          onChange={(e) => onChange({ displayName: e.target.value })}
          placeholder="github-pat"
          maxLength={255}
        />
      </div>
      <div className="grid gap-2">
        <Label>凭据类型</Label>
        <Select
          value={form.authType}
          disabled={!isCreate}
          onValueChange={(v) => onChange({ authType: v as AuthType })}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(AUTH_TYPE_LABEL) as AuthType[]).map((type) => (
              <SelectItem key={type} value={type}>
                {AUTH_TYPE_LABEL[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!isCreate ? (
          <p className="text-muted-foreground text-xs">凭据类型创建后不可更改,只能轮换 secret。</p>
        ) : null}
      </div>
      {isMcp ? (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-mcp-url`}>MCP 服务器地址</Label>
          <Input
            id={`${idPrefix}-mcp-url`}
            className="font-mono"
            value={form.mcpServerUrl}
            onChange={(e) => onChange({ mcpServerUrl: e.target.value })}
            placeholder="https://mcp.example.com/mcp"
          />
          <p className="text-muted-foreground text-xs">公开的 HTTPS Streamable HTTP 地址。</p>
        </div>
      ) : null}
      {isHost ? (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-host`}>Host</Label>
          <Input
            id={`${idPrefix}-host`}
            className="font-mono"
            value={form.host}
            onChange={(e) => onChange({ host: e.target.value })}
            placeholder="https://api.example.com"
          />
          <p className="text-muted-foreground text-xs">仅 HTTPS origin,不带路径与 query。</p>
        </div>
      ) : null}
      {isEnvVar ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-secret-name`}>变量名</Label>
            <Input
              id={`${idPrefix}-secret-name`}
              className="font-mono"
              value={form.secretName}
              onChange={(e) => onChange({ secretName: e.target.value })}
              placeholder="GITHUB_TOKEN"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-networking`}>注入后的出网范围</Label>
            <Select
              value={form.networkingType}
              onValueChange={(v) => onChange({ networkingType: v as CredentialFormState["networkingType"] })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unrestricted">unrestricted — 自由出网</SelectItem>
                <SelectItem value="limited">limited — 仅放行指定主机</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.networkingType === "limited" ? (
            <div className="grid gap-2">
              <Label htmlFor={`${idPrefix}-hosts`}>放行的主机(一行一个)</Label>
              <Textarea
                id={`${idPrefix}-hosts`}
                rows={3}
                value={form.allowedHosts}
                onChange={(e) => onChange({ allowedHosts: e.target.value })}
                placeholder={"api.github.com\n*.githubusercontent.com"}
              />
              <p className="text-muted-foreground text-xs">最多 16 项;限定凭据可被发送到的目标 host。</p>
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.injectHeader}
              onCheckedChange={(v) => onChange({ injectHeader: v === true })}
            />
            允许注入到请求头(body 注入当前不支持)
          </label>
        </>
      ) : null}
      {usesAccessToken ? (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-access-token`}>access_token{isCreate ? "" : "(留空 = 保留现有值)"}</Label>
          <Input
            id={`${idPrefix}-access-token`}
            type="password"
            autoComplete="new-password"
            value={form.accessToken}
            onChange={(e) => onChange({ accessToken: e.target.value })}
          />
        </div>
      ) : null}
      {usesToken ? (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-token`}>token{isCreate ? "" : "(留空 = 保留现有值)"}</Label>
          <Input
            id={`${idPrefix}-token`}
            type="password"
            autoComplete="new-password"
            value={form.token}
            onChange={(e) => onChange({ token: e.target.value })}
          />
        </div>
      ) : null}
      {isEnvVar ? (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-secret-value`}>变量值{isCreate ? "" : "(留空 = 保留现有值)"}</Label>
          <Input
            id={`${idPrefix}-secret-value`}
            type="password"
            autoComplete="new-password"
            value={form.secretValue}
            onChange={(e) => onChange({ secretValue: e.target.value })}
          />
        </div>
      ) : null}
      {usesExpires ? (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-expires`}>过期时间(可选)</Label>
          <Input
            id={`${idPrefix}-expires`}
            type="datetime-local"
            value={form.expiresAt}
            onChange={(e) => onChange({ expiresAt: e.target.value })}
          />
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">
        所有 secret 字段只写不回显:保存后无法再从控制台读取。
      </p>
    </div>
  );
}

function useCredentialMutation(submit: () => Promise<unknown>, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submit,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["vaults"] });
      onDone();
    },
  });
}

/** 在 Vault 中添加凭据;secret 只写不回显 */
export function CreateCredentialDialog({
  vaultId,
  open,
  onOpenChange,
}: {
  vaultId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<CredentialFormState>(blankForm);
  const [attempted, setAttempted] = useState(false);

  function close() {
    onOpenChange(false);
    setForm(blankForm());
    setAttempted(false);
  }

  const error = validateForm(form, true);
  const mutation = useCredentialMutation(() => {
    const input: CredentialCreateInput = {
      auth: buildAuthCreate(form),
    };
    if (form.displayName.trim()) input.display_name = form.displayName.trim();
    return createCredential(vaultId, input);
  }, close);

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus /> 添加凭据
      </Button>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加凭据</DialogTitle>
          <DialogDescription>
            凭据由平台保管;会话通过 vault 引用后按需注入,控制台不会再显示 secret。
          </DialogDescription>
        </DialogHeader>
        <CredentialFormFields
          form={form}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          isCreate
        />
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
            {mutation.isPending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 轮换 secret 或调整过期时间;类型与目标地址不可改 */
export function UpdateCredentialDialog({ vaultId, credential }: { vaultId: string; credential: Credential }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CredentialFormState>(() => ({
    ...blankForm(),
    displayName: credential.display_name,
    authType: credential.auth.type,
  }));
  const [attempted, setAttempted] = useState(false);

  function openDialog() {
    setForm((prev) => ({ ...prev, displayName: credential.display_name }));
    setAttempted(false);
    setOpen(true);
  }

  const error = validateForm(form, false);
  const mutation = useCredentialMutation(() => {
    const input: CredentialUpdateInput = {
      display_name: form.displayName.trim() || null,
      auth: buildAuthUpdate(form),
    };
    return updateCredential(vaultId, credential.id, input);
  }, () => setOpen(false));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={openDialog}>
        编辑
      </Button>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑凭据</DialogTitle>
          <DialogDescription>可修改显示名称并轮换 secret;留空表示保留现有值。</DialogDescription>
        </DialogHeader>
        <CredentialFormFields
          form={form}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          isCreate={false}
        />
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
