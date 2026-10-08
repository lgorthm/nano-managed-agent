import type { Session } from '@nano/shared/glm';
import { Inbox, Search } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { TraceComposer } from './components/trace-composer';
import { TraceDetailPane } from './components/trace-detail-pane';
import { TraceList, type TraceListHandle } from './components/trace-list';
import { TraceStatusBar } from './components/trace-status-bar';
import { TraceToolbar } from './components/trace-toolbar';
import type { SessionTraceEvent } from './data/use-session-events';
import { useTraceView } from './state/use-trace-view';
import { TraceTimeline } from './timeline/trace-timeline';

interface SessionTraceProps {
  active: boolean;
  session: Session;
  events: readonly SessionTraceEvent[];
  loading: boolean;
  error: Error | null;
  refreshing: boolean;
  onRefresh: () => void;
  attachmentAction?: ReactNode;
}

/** Owns Trace interaction state. Event transport and the surrounding Session tabs live outside. */
export function SessionTrace({
  active,
  session,
  events,
  loading,
  error,
  refreshing,
  onRefresh,
  attachmentAction,
}: SessionTraceProps) {
  const view = useTraceView(events, session.agent.system);
  const { state, dispatch, selectedRecord, selectRecord } = view;
  const listRef = useRef<TraceListHandle>(null);

  useEffect(() => {
    if (active && state.selectionRevision > 0 && state.selectedKey) {
      listRef.current?.scrollToKey(state.selectedKey);
    }
  }, [active, state.selectedKey, state.selectionRevision]);

  useEffect(() => {
    if (active && view.focusKeys) listRef.current?.scrollToFocus(view.focusKeys);
  }, [active, view.focusKeys]);

  return (
    <section className="session-trace" aria-label="Session Trace">
      <TraceToolbar
        state={state}
        dispatch={dispatch}
        toolSteps={view.toolSteps}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
      {loading ? (
        <Skeleton className="h-11 w-full shrink-0" />
      ) : view.timeline ? (
        <TraceTimeline
          key={state.mode}
          model={view.timeline}
          mode={state.mode}
          range={state.range}
          onRangeChange={view.selectRange}
          selectedKey={state.selectedKey}
          searchMatchKeys={view.searchMatches}
          laneFilter={state.lane}
          onItemSelect={selectRecord}
          onItemFocus={selectRecord}
        />
      ) : (
        <div className="trace-timeline-empty">事件处理后会显示时间线</div>
      )}
      <div className="trace-workspace">
        <div className="trace-main">
          {error ? (
            <div className="trace-query-error">
              <QueryError error={error} />
            </div>
          ) : null}
          {loading ? (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
              <Skeleton className="h-7 w-full" />
            </div>
          ) : view.records.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="暂无轨迹"
              description="发送一条消息，开始查看这个会话的执行过程。"
            />
          ) : view.visibleRecords.length === 0 ? (
            <div className="trace-no-matches">
              <EmptyState
                icon={Search}
                title="没有匹配的记录"
                description="试试其他关键词，或清除筛选条件。"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  dispatch({ type: 'search', value: '' });
                  dispatch({ type: 'lane', value: 'all' });
                }}
              >
                清除筛选
              </Button>
            </div>
          ) : (
            <TraceList
              ref={listRef}
              records={view.visibleRecords}
              liveTailKey={view.records.at(-1)?.key ?? null}
              selectedKey={state.selectedKey}
              focusKeys={view.focusKeys}
              showDuration={state.showDuration}
              groupTurns={state.groupTurns}
              collapsedTurns={state.collapsedTurns}
              collapsedSteps={state.collapsedSteps}
              onSelect={selectRecord}
              onToggleTurn={(turn) => dispatch({ type: 'toggle-turn', turn })}
              onToggleStep={(turn, step) => dispatch({ type: 'toggle-step', turn, step })}
            />
          )}
          <TraceComposer session={session} attachmentAction={attachmentAction} />
        </div>
        {active && selectedRecord ? (
          <TraceDetailPane
            record={selectedRecord}
            events={events}
            session={session}
            onClose={() => dispatch({ type: 'close-detail' })}
          />
        ) : null}
      </div>
      <TraceStatusBar session={session} records={view.records} />
    </section>
  );
}
