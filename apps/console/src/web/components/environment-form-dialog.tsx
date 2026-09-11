import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  Environment,
  EnvironmentConfigInput,
  EnvironmentNetworkingInput,
  EnvironmentPackagesInput,
} from "@nano/shared/glm";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { createEnvironment, updateEnvironment } from "@/api/environments";
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

type PackageManager = "apt" | "cargo" | "gem" | "go" | "npm" | "pip";

/** 服务端按 apt → cargo → gem → go → npm → pip 的顺序安装 */
const PACKAGE_MANAGERS: PackageManager[] = ["apt", "cargo", "gem", "go", "npm", "pip"];

const PACKAGE_PLACEHOLDER: Record<PackageManager, string> = {
  apt: "poppler-utils",
  cargo: "ripgrep",
  gem: "rails",
  go: "hugo",
  npm: "typescript",
  pip: "pandas\nmatplotlib",
};

interface EnvironmentFormState {
  name: string;
  description: string;
  networkingType: "unrestricted" | "limited";
  /** 一行一个 host */
  allowedHosts: string;
  allowPackageManagers: boolean;
  allowMcpServers: boolean;
  /** 每个包管理器一个文本域,一行一项 */
  packages: Record<PackageManager, string>;
}

function blankForm(): EnvironmentFormState {
  return {
    name: "",
    description: "",
    networkingType: "unrestricted",
    allowedHosts: "",
    allowPackageManagers: false,
    allowMcpServers: false,
    packages: { apt: "", cargo: "", gem: "", go: "", npm: "", pip: "" },
  };
}

/** 响应侧的完整配置 → 表单初值 */
function formFromEnvironment(environment: Environment): EnvironmentFormState {
  const { config } = environment;
  const packages = { ...blankForm().packages };
  for (const manager of PACKAGE_MANAGERS) {
    packages[manager] = config.packages[manager].join("\n");
  }
  return {
    name: environment.name,
    description: environment.description ?? "",
    networkingType: config.networking.type,
    allowedHosts: config.networking.type === "limited" ? config.networking.allowed_hosts.join("\n") : "",
    allowPackageManagers: config.networking.type === "limited" ? config.networking.allow_package_managers : false,
    allowMcpServers: config.networking.type === "limited" ? config.networking.allow_mcp_servers : false,
    packages,
  };
}

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 与服务端一致的包名校验:trim 后非空、无空白/控制字符、不以 - 开头、每类 ≤200 项且单项 ≤256 字符 */
function validatePackageItems(manager: PackageManager, items: string[]): string | null {
  if (items.length > 200) return `${manager} 最多 200 项`;
  for (const item of items) {
    if (item.length > 256) return `${manager} 中的 "${item.slice(0, 24)}…" 超过 256 字符`;
    if (/[\s\u0000-\u001f\u007f]/.test(item)) return `${manager} 中的 "${item}" 含空白或控制字符`;
    if (item.startsWith("-")) return `${manager} 中的 "${item}" 不能以 - 开头`;
  }
  return null;
}

/** 与服务端一致的 host 校验:仅接受主机名或 *.example.com 通配,不带协议、端口或路径 */
function validateHosts(hosts: string[]): string | null {
  if (hosts.length > 256) return "allowed_hosts 最多 256 项";
  for (const host of hosts) {
    if (host.length > 255) return `host "${host.slice(0, 24)}…" 超过 255 字符`;
    if (host.includes("://")) return `host "${host}" 不能带协议前缀,写 github.com 而不是 https://github.com`;
    if (host.includes("/") || host.includes(":")) return `host "${host}" 不能带端口或路径`;
  }
  return null;
}

/** 表单 → 请求体 config;空文本域的包管理器不下发,limited 按当前开关完整提交 */
function buildConfig(form: EnvironmentFormState): EnvironmentConfigInput {
  const packages: EnvironmentPackagesInput = {};
  for (const manager of PACKAGE_MANAGERS) {
    const items = parseLines(form.packages[manager]);
    if (items.length > 0) packages[manager] = items;
  }
  const networking: EnvironmentNetworkingInput =
    form.networkingType === "unrestricted"
      ? { type: "unrestricted" }
      : {
          type: "limited",
          allowed_hosts: parseLines(form.allowedHosts),
          allow_package_managers: form.allowPackageManagers,
          allow_mcp_servers: form.allowMcpServers,
        };
  return { type: "cloud", packages, networking };
}

/** 提交前的本地校验;返回第一条错误 */
function validateForm(form: EnvironmentFormState): string | null {
  if (!form.name.trim()) return "名称不能为空";
  for (const manager of PACKAGE_MANAGERS) {
    const error = validatePackageItems(manager, parseLines(form.packages[manager]));
    if (error) return error;
  }
  if (form.networkingType === "limited") {
    const hostsError = validateHosts(parseLines(form.allowedHosts));
    if (hostsError) return hostsError;
    // 服务端硬约束:limited 声明了 packages 时必须显式放行包管理器,否则 400
    const hasPackages = PACKAGE_MANAGERS.some((m) => parseLines(form.packages[m]).length > 0);
    if (hasPackages && !form.allowPackageManagers) {
      return "limited 网络下声明了软件包时,必须允许包管理器联网,否则安装会失败";
    }
  }
  return null;
}

function EnvironmentFormFields({
  form,
  onChange,
  idPrefix,
}: {
  form: EnvironmentFormState;
  onChange: (patch: Partial<EnvironmentFormState>) => void;
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
          placeholder="data-analysis-env"
          maxLength={256}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-description`}>描述</Label>
        <Input
          id={`${idPrefix}-description`}
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="可选,用途说明"
          maxLength={1024}
        />
      </div>
      <div className="grid gap-2">
        <Label>网络策略</Label>
        <Select
          value={form.networkingType}
          onValueChange={(v) => onChange({ networkingType: v as EnvironmentFormState["networkingType"] })}
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
        <div className="bg-muted/40 grid gap-3 rounded-lg border p-3">
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-hosts`}>放行的主机(一行一个)</Label>
            <Textarea
              id={`${idPrefix}-hosts`}
              rows={3}
              value={form.allowedHosts}
              onChange={(e) => onChange({ allowedHosts: e.target.value })}
              placeholder={"api.example.com\n*.internal.example.com"}
            />
            <p className="text-muted-foreground text-xs">
              只接受主机名或 *.example.com 通配,不带协议、端口或路径;最多 256 项。
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.allowPackageManagers}
              onCheckedChange={(v) => onChange({ allowPackageManagers: v === true })}
            />
            允许包管理器联网(声明了软件包时必须开启)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.allowMcpServers}
              onCheckedChange={(v) => onChange({ allowMcpServers: v === true })}
            />
            允许 MCP 服务器联网
          </label>
        </div>
      ) : null}
      <div className="grid gap-2">
        <Label>预装软件包(可选,一行一个)</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {PACKAGE_MANAGERS.map((manager) => (
            <div key={manager} className="grid gap-1">
              <Label htmlFor={`${idPrefix}-pkg-${manager}`} className="text-muted-foreground font-mono text-xs">
                {manager}
              </Label>
              <Textarea
                id={`${idPrefix}-pkg-${manager}`}
                rows={2}
                className="min-h-0 font-mono text-xs"
                value={form.packages[manager]}
                onChange={(e) => onChange({ packages: { ...form.packages, [manager]: e.target.value } })}
                placeholder={PACKAGE_PLACEHOLDER[manager]}
              />
            </div>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          在预装运行时基线上增装;每类最多 200 项,按 apt → cargo → gem → go → npm → pip 顺序安装。
        </p>
      </div>
    </div>
  );
}

function useEnvironmentMutation(
  submit: () => Promise<unknown>,
  onDone: () => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submit,
    onSuccess: () => {
      // 前缀匹配同时覆盖列表与详情查询
      void queryClient.invalidateQueries({ queryKey: ["environments"] });
      onDone();
    },
  });
}

/** 创建 Environment:全部留空即为默认配置(cloud + 空 packages + unrestricted) */
export function CreateEnvironmentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<EnvironmentFormState>(blankForm);
  // 校验错误只在点击提交后展示,避免打开对话框就满屏红字
  const [attempted, setAttempted] = useState(false);

  function close() {
    onOpenChange(false);
    setForm(blankForm());
    setAttempted(false);
  }

  const error = validateForm(form);
  const mutation = useEnvironmentMutation(
    () =>
      createEnvironment({
        name: form.name.trim(),
        description: form.description.trim() || null,
        config: buildConfig(form),
      }),
    close,
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus /> 新建 Environment
      </Button>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建 Environment</DialogTitle>
          <DialogDescription>
            会话沙箱的蓝图:声明预装软件包与出网策略,创建后可在多个会话与部署里复用。
          </DialogDescription>
        </DialogHeader>
        <EnvironmentFormFields form={form} onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))} idPrefix="create-env" />
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

/** 编辑 Environment:config 整体替换,保存后只影响之后创建的会话 */
export function UpdateEnvironmentDialog({ environment }: { environment: Environment }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EnvironmentFormState>(() => formFromEnvironment(environment));
  const [attempted, setAttempted] = useState(false);

  const initial = formFromEnvironment(environment);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const error = validateForm(form);

  function openDialog() {
    setForm(formFromEnvironment(environment));
    setAttempted(false);
    setOpen(true);
  }

  const mutation = useEnvironmentMutation(
    () =>
      updateEnvironment(environment.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        config: buildConfig(form),
      }),
    () => setOpen(false),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Pencil /> 编辑
      </Button>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑 Environment</DialogTitle>
          <DialogDescription>
            配置整体替换;更新只影响之后创建的会话,正在运行的会话不受影响。
          </DialogDescription>
        </DialogHeader>
        <EnvironmentFormFields form={form} onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))} idPrefix="update-env" />
        {attempted && error ? <p className="text-destructive text-sm">{error}</p> : null}
        {mutation.isError ? <p className="text-destructive text-sm">{(mutation.error as Error).message}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setOpen(false)}>
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
            {mutation.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
