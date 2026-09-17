import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { listAgents } from '@/api/agents';
import { listEnvironments } from '@/api/environments';
import { createSession } from '@/api/sessions';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { shortId } from '@/lib/format';

/**
 * 新建会话对话框:选 Agent(未归档)与 Environment(active),可选标题与
 * 首条消息(initial_events,创建即驱动第一轮对话);成功后跳详情页。
 */
export function SessionCreateDialog() {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [title, setTitle] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [attempted, setAttempted] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const agentsQuery = useQuery({
    queryKey: ['agents', 'for-session'],
    queryFn: () => listAgents({ limit: 100 }),
    enabled: open,
  });
  const environmentsQuery = useQuery({
    queryKey: ['environments', 'for-session'],
    queryFn: () => listEnvironments({ limit: 100 }),
    enabled: open,
  });
  const agents = (agentsQuery.data?.data ?? []).filter((agent) => agent.archived_at === null);
  const environments = (environmentsQuery.data?.data ?? []).filter(
    (environment) => environment.state === 'active',
  );

  function close() {
    setOpen(false);
    setAgentId('');
    setEnvironmentId('');
    setTitle('');
    setFirstMessage('');
    setAttempted(false);
  }

  const mutation = useMutation({
    mutationFn: () =>
      createSession({
        agent: agentId,
        environment_id: environmentId,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(firstMessage.trim()
          ? {
              initial_events: [
                {
                  type: 'user.message',
                  content: [{ type: 'text', text: firstMessage.trim() }],
                },
              ],
            }
          : {}),
      }),
    onSuccess: (session) => {
      close();
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      navigate(`/sessions/${session.id}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={mutation.isPending ? undefined : close}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus /> 新建会话
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
          <DialogDescription>
            选择 Agent 与 Environment 创建会话;填了首条消息的话,创建后会立刻跑第一轮对话。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>Agent</Label>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    agentsQuery.isPending
                      ? '加载中…'
                      : agents.length === 0
                        ? '暂无可选 Agent'
                        : '选择 Agent'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name} ({shortId(agent.id)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agents.length === 0 && !agentsQuery.isPending ? (
              <p className="text-muted-foreground text-xs">请先在 Agents 页面创建 Agent。</p>
            ) : null}
          </div>
          <div className="grid gap-2">
            <Label>Environment</Label>
            <Select value={environmentId} onValueChange={setEnvironmentId}>
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    environmentsQuery.isPending
                      ? '加载中…'
                      : environments.length === 0
                        ? '暂无可选 Environment'
                        : '选择 Environment'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {environments.map((environment) => (
                  <SelectItem key={environment.id} value={environment.id}>
                    {environment.name} ({shortId(environment.id)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {environments.length === 0 && !environmentsQuery.isPending ? (
              <p className="text-muted-foreground text-xs">
                请先在 Environments 页面创建 Environment。
              </p>
            ) : null}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="session-title">标题(可选)</Label>
            <Input
              id="session-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="给会话起个名字"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="session-first-message">首条消息(可选)</Label>
            <Textarea
              id="session-first-message"
              rows={3}
              value={firstMessage}
              onChange={(e) => setFirstMessage(e.target.value)}
              placeholder="作为 initial_events 随创建提交,创建后立即驱动第一轮对话"
            />
          </div>
        </div>
        {attempted && !agentId ? <p className="text-destructive text-sm">请选择 Agent</p> : null}
        {attempted && !environmentId ? (
          <p className="text-destructive text-sm">请选择 Environment</p>
        ) : null}
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
              if (agentId && environmentId) mutation.mutate();
            }}
          >
            {mutation.isPending ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
