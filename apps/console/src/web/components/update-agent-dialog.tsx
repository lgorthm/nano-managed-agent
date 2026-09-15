import { useMutation, useQueryClient } from "@tanstack/react-query";
import { defaultModelEffort } from "@nano/shared";
import type { Agent, AgentUpdateInput, GlmModelId, ModelEffort } from "@nano/shared/glm";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { updateAgent } from "@/api/agents";
import { groupedModelOptions, useModelOptions, type ModelOption } from "@/api/models";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** 编辑时当前模型若不在目录里(如动态模型尚未拉取),补进选项保证 Select 能回显 */
function withCurrentModel(options: ModelOption[], currentId: string): ModelOption[] {
  if (options.some((option) => option.id === currentId)) return options;
  return [...options, { id: currentId, label: currentId, defaultEffort: defaultModelEffort(currentId) }];
}

/**
 * 编辑 Agent 的名称、描述、模型、系统提示词与内置工具集开关。
 * 补丁按差异构造:未变化的字段省略(服务端语义为保持不变);
 * tools 是整体替换,仅在勾选状态变化时提交,且含 mcp/自定义工具集的 Agent
 * 无法用单个开关表达,此时禁用开关、不提交 tools,避免覆盖 API 配置的工具。
 * 携带 version 做乐观并发控制,并发修改时服务端返回 409。
 */
export function UpdateAgentDialog({ agent }: { agent: Agent }) {
  const { options: modelOptions, isLoading: modelsLoading } = useModelOptions();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model.id);
  const [effort, setEffort] = useState<ModelEffort>(agent.model.effort ?? defaultModelEffort(agent.model.id));
  const [system, setSystem] = useState(agent.system ?? "");
  const hasBuiltinToolset = agent.tools.some((toolset) => toolset.type === "agent_toolset_20260601");
  const hasOtherToolsets = agent.tools.some((toolset) => toolset.type !== "agent_toolset_20260601");
  const [withToolset, setWithToolset] = useState(hasBuiltinToolset);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (patch: AgentUpdateInput) => updateAgent(agent.id, patch),
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  function openDialog() {
    setName(agent.name);
    setDescription(agent.description ?? "");
    setModel(agent.model.id);
    setEffort(agent.model.effort ?? defaultModelEffort(agent.model.id));
    setSystem(agent.system ?? "");
    setWithToolset(hasBuiltinToolset);
    mutation.reset();
    setOpen(true);
  }

  const effortInitial = agent.model.effort ?? defaultModelEffort(agent.model.id);
  const dirty =
    name !== agent.name ||
    description !== (agent.description ?? "") ||
    model !== agent.model.id ||
    effort !== effortInitial ||
    system !== (agent.system ?? "") ||
    (!hasOtherToolsets && withToolset !== hasBuiltinToolset);

  function submit() {
    const patch: AgentUpdateInput = {
      version: agent.version,
      name: name.trim(),
      // 同创建侧:动态模型 id 经收窄上行,nano 后端接受任意非空 id
      model: { id: model as GlmModelId, effort },
      system: system.trim() || null,
      description: description.trim() || null,
    };
    if (!hasOtherToolsets && withToolset !== hasBuiltinToolset) {
      patch.tools = withToolset ? [{ type: "agent_toolset_20260601" }] : [];
    }
    mutation.mutate(patch);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={openDialog}>
        <Pencil /> 编辑
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑 Agent</DialogTitle>
          <DialogDescription>保存会生成新版本,历史版本保留在版本记录中。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="update-agent-name">名称</Label>
            <Input id="update-agent-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="update-agent-description">描述</Label>
            <Input
              id="update-agent-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>模型</Label>
              <Select
                value={model}
                onValueChange={(v) => {
                  setModel(v);
                  const selected = modelOptions.find((option) => option.id === v);
                  if (selected !== undefined) setEffort(selected.defaultEffort);
                }}
                disabled={modelsLoading}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {groupedModelOptions(withCurrentModel(modelOptions, model)).map((group) =>
                    group.label === null ? (
                      group.options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectGroup key={group.label}>
                        <SelectLabel>{group.label}</SelectLabel>
                        {group.options.map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>推理强度</Label>
              <Select value={effort} onValueChange={(v) => setEffort(v as ModelEffort)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="max">max</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="update-agent-system">系统提示词</Label>
            <Textarea
              id="update-agent-system"
              rows={4}
              value={system}
              onChange={(e) => setSystem(e.target.value)}
              placeholder="You are a helpful coding agent."
            />
          </div>
          <label className={`flex items-center gap-2 text-sm ${hasOtherToolsets ? "opacity-60" : ""}`}>
            <Checkbox
              checked={withToolset}
              disabled={hasOtherToolsets}
              onCheckedChange={(v) => setWithToolset(v === true)}
            />
            启用内置工具集 agent_toolset_20260601
            {hasOtherToolsets ? (
              <span className="text-muted-foreground text-xs">(含 API 配置的工具集,此处不可改)</span>
            ) : null}
          </label>
        </div>
        {mutation.isError ? (
          <p className="text-destructive text-sm">{(mutation.error as Error).message}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={mutation.isPending} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button size="sm" disabled={!name.trim() || !dirty || mutation.isPending} onClick={submit}>
            {mutation.isPending ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
