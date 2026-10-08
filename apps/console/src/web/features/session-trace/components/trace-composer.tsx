import type { Session } from '@nano/shared/glm';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Loader2, Square } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { sendSessionEvents } from '@/api/sessions';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function TraceComposer({
  session,
  attachmentAction,
}: {
  session: Session;
  attachmentAction?: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const queryClient = useQueryClient();
  const archived = session.archived_at !== null;
  const send = useMutation({
    mutationFn: (text: string) =>
      sendSessionEvents(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
      }),
    onSuccess: (_result, sentText) => {
      setDraft((current) => (current.trim() === sentText ? '' : current));
      void queryClient.invalidateQueries({ queryKey: ['sessions', session.id] });
    },
  });
  const interrupt = useMutation({
    mutationFn: () => sendSessionEvents(session.id, { events: [{ type: 'user.interrupt' }] }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', session.id] });
    },
  });

  function submit() {
    const text = draft.trim();
    if (text && !archived && !send.isPending) send.mutate(text);
  }

  return (
    <div className="trace-composer-area">
      <form
        className="trace-composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Textarea
          aria-label="发送会话消息"
          rows={2}
          value={draft}
          disabled={archived}
          placeholder={archived ? '会话已归档，无法发送消息' : '发送消息，继续这个会话…'}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="trace-composer-actions">
          <div className="flex min-w-0 items-center gap-2">
            {attachmentAction}
            <span className="trace-composer-shortcut">⌘ / Ctrl + Enter 发送</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="trace-composer-model" title={session.agent.model.id}>
              {session.agent.model.id} {session.agent.model.effort ?? ''}
            </span>
            {!archived && session.status === 'running' ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={interrupt.isPending}
                aria-label="打断会话"
                title="打断会话"
                onClick={() => interrupt.mutate()}
              >
                {interrupt.isPending ? <Loader2 className="animate-spin" /> : <Square />}
              </Button>
            ) : null}
            <Button
              type="submit"
              size="icon-sm"
              className="trace-send-button"
              disabled={archived || !draft.trim() || send.isPending}
              aria-label={send.isPending ? '正在发送' : '发送消息'}
            >
              {send.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
        </div>
        {send.isError || interrupt.isError ? (
          <p className="trace-composer-error" role="alert">
            {(send.error ?? interrupt.error)?.message}
          </p>
        ) : null}
      </form>
    </div>
  );
}
