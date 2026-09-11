import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Deployment, DeploymentUpdateInput } from "@nano/shared/glm";
import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { listAgents } from "@/api/agents";
import { listEnvironments } from "@/api/environments";
import { createDeployment, updateDeployment } from "@/api/deployments";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface DeploymentFormState {
  name: string;
  agentId: string;
  environmentId: string;
  /** 空 = 仅手动运行 */
  cronExpression: string;
  /** 每次运行注入的初始消息;创建时必填,编辑时留空 = 保持不变 */
  initialMessage: string;
  description: string;
}

function validateCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return "cron 表达式必须是 5 段(分 时 日 月 星期),如 0 9 * * 1-5";
  return null;
}

function validateForm(form: DeploymentFormState, isCreate: boolean): string | null {
  if (!form.name.trim()) return "名称不能为空";
  if (isCreate && !form.agentId) return "请选择 Agent";
  if (isCreate && !form.environmentId) return "请选择 Environment";
  if (form.cronExpression.trim() && validateCron(form.cronExpression)) {
    return validateCron(form.cronExpression)!;
  }
  if (isCreate && !form.initialMessage.trim()) {
    return "初始消息不能为空:部署每次运行都会以它启动会话";
  }
  return null;
}

/** 轻量选择器:一次拉 50 个 active 资源供下拉,足够管理台使用 */
function useResourceOptions() {
  const agentsQuery = useQuery({
    queryKey: ["agents", "for-deployment"],
    queryFn: () => listAgents({ limit: 50 }),
  });
  const environmentsQuery = useQuery({
    queryKey: ["environments", "for-deployment"],
    queryFn: () => listEnvironments({ limit: 50 }),
  });
  return {
    agents: (agentsQuery.data?.data ?? []).filter((agent) => !agent.archived_at),
    environments: (environmentsQuery.data?.data ?? []).filter(
      (environment) => environment.state === "active",
    ),
  };
}

function DeploymentFormFields({
  form,
  onChange,
  isCreate,
}: {
  form: DeploymentFormState;
  onChange: (patch: Partial<DeploymentFormState>) => void;
  isCreate: boolean;
}) {
  const { agents, environments } = useResourceOptions();
  const idPrefix = isCreate ? "create-deployment" : "update-deployment";
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-name`}>名称</Label>
        <Input
          id={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="daily-report"
        />
      </div>
      {isCreate ? (
        <>
          <div className="grid gap-2">
            <Label>Agent</Label>
            <Select value={form.agentId} onValueChange={(v) => onChange({ agentId: v })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={agents.length === 0 ? "暂无可选 Agent" : "选择 Agent"} />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name} (v{agent.version})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">部署固定当前最新版本;更新部署时可重新固定。</p>
          </div>
          <div className="grid gap-2">
            <Label>Environment</Label>
            <Select value={form.environmentId} onValueChange={(v) => onChange({ environmentId: v })}>
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={environments.length === 0 ? "暂无可选 Environment" : "选择 Environment"}
                />
              </SelectTrigger>
              <SelectContent>
                {environments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      ) : null}
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-cron`}>Cron 表达式(可选,时区 Asia/Shanghai)</Label>
        <Input
          id={`${idPrefix}-cron`}
          className="font-mono"
          value={form.cronExpression}
          onChange={(e) => onChange({ cronExpression: e.target.value })}
          placeholder="0 9 * * 1-5"
        />
        <p className="text-muted-foreground text-xs">留空表示仅手动运行。</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-message`}>
          初始消息{isCreate ? "" : "(留空 = 保持不变)"}
        </Label>
        <Textarea
          id={`${idPrefix}-message`}
          rows={4}
          value={form.initialMessage}
          onChange={(e) => onChange({ initialMessage: e.target.value })}
          placeholder="每次运行时以 user.message 启动会话,告诉 Agent 这次要做什么…"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-description`}>描述(可选)</Label>
        <Input
          id={`${idPrefix}-description`}
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          maxLength={1024}
        />
      </div>
    </div>
  );
}

function useDeploymentMutation(submit: () => Promise<unknown>, onDone: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submit,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
      onDone();
    },
  });
}

function blankForm(): DeploymentFormState {
  return { name: "", agentId: "", environmentId: "", cronExpression: "", initialMessage: "", description: "" };
}

/** 创建 Deployment:固定 Agent 当前版本 + 环境,按 cron 或手动运行 */
export function CreateDeploymentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState<DeploymentFormState>(blankForm);
  const [attempted, setAttempted] = useState(false);

  function close() {
    onOpenChange(false);
    setForm(blankForm());
    setAttempted(false);
  }

  const error = validateForm(form, true);
  const mutation = useDeploymentMutation(
    () =>
      createDeployment({
        name: form.name.trim(),
        agent: { type: "agent", id: form.agentId },
        environment_id: form.environmentId,
        ...(form.cronExpression.trim()
          ? { schedule: { type: "cron" as const, expression: form.cronExpression.trim() } }
          : {}),
        initial_events: [
          { type: "user.message" as const, content: [{ type: "text" as const, text: form.initialMessage.trim() }] },
        ],
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      }),
    close,
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button size="sm" onClick={() => onOpenChange(true)}>
        <Plus /> 新建 Deployment
      </Button>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建 Deployment</DialogTitle>
          <DialogDescription>
            把某个版本的 Agent 按定时计划(或手动)跑起来:每次运行创建一个会话并注入初始消息。
          </DialogDescription>
        </DialogHeader>
        <DeploymentFormFields
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

type ScheduleChoice = "keep" | "manual" | "cron";

/** 更新 Deployment:改名/描述/调度/初始消息;Agent 与环境不在此时切换 */
export function UpdateDeploymentDialog({ deployment }: { deployment: Deployment }) {
  const existingMessage = deployment.initial_events
    .map((event) => event.content.map((block) => (block.type === "text" ? block.text : "")).join("\n"))
    .join("\n");
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ScheduleChoice>("keep");
  const [form, setForm] = useState<DeploymentFormState>(() => ({
    ...blankForm(),
    name: deployment.name,
    cronExpression: deployment.schedule?.expression ?? "",
    initialMessage: existingMessage,
    description: deployment.description ?? "",
  }));
  const [attempted, setAttempted] = useState(false);

  const error = validateForm(form, false) ??
    (choice === "cron" ? validateCron(form.cronExpression) : null);

  function openDialog() {
    setChoice("keep");
    setForm({
      ...blankForm(),
      name: deployment.name,
      cronExpression: deployment.schedule?.expression ?? "",
      initialMessage: existingMessage,
      description: deployment.description ?? "",
    });
    setAttempted(false);
    setOpen(true);
  }

  const mutation = useDeploymentMutation(() => {
    const input: DeploymentUpdateInput = {
      name: form.name.trim(),
      ...(form.description.trim() !== (deployment.description ?? "")
        ? { description: form.description.trim() || null }
        : {}),
    };
    if (choice === "manual") input.schedule = null;
    if (choice === "cron") {
      input.schedule = { type: "cron", expression: form.cronExpression.trim() };
    }
    if (form.initialMessage.trim() && form.initialMessage.trim() !== existingMessage.trim()) {
      input.initial_events = [
        { type: "user.message", content: [{ type: "text", text: form.initialMessage.trim() }] },
      ];
    }
    return updateDeployment(deployment.id, input);
  }, () => setOpen(false));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Pencil /> 编辑
      </Button>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑 Deployment</DialogTitle>
          <DialogDescription>
            名称、描述、调度与初始消息可更新;Agent 固定与 Environment 绑定需要在更新接口中显式指定,控制台暂不改动。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>调度</Label>
            <Select value={choice} onValueChange={(v) => setChoice(v as ScheduleChoice)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">保持不变({deployment.schedule ? deployment.schedule.expression : "仅手动"})</SelectItem>
                <SelectItem value="manual">改为仅手动运行</SelectItem>
                <SelectItem value="cron">使用 Cron 定时</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {choice === "cron" ? (
            <div className="grid gap-2">
              <Label htmlFor="update-deployment-cron">Cron 表达式(Asia/Shanghai)</Label>
              <Input
                id="update-deployment-cron"
                className="font-mono"
                value={form.cronExpression}
                onChange={(e) => setForm((prev) => ({ ...prev, cronExpression: e.target.value }))}
                placeholder="0 9 * * 1-5"
              />
            </div>
          ) : null}
        </div>
        <DeploymentFormFields
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
