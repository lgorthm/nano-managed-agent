import { Clock3, Layers2, ListFilter, RefreshCw, Search, Wrench, X } from 'lucide-react';
import type { Dispatch } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { TraceViewAction, TraceViewState } from '../state/trace-view-state';

interface TraceToolbarProps {
  state: TraceViewState;
  dispatch: Dispatch<TraceViewAction>;
  toolSteps: ReadonlySet<string>;
  refreshing: boolean;
  onRefresh: () => void;
}

export function TraceToolbar({
  state,
  dispatch,
  toolSteps,
  refreshing,
  onRefresh,
}: TraceToolbarProps) {
  const callsExpanded =
    toolSteps.size === 0 || ![...toolSteps].every((key) => state.collapsedSteps.has(key));
  return (
    <fieldset className="trace-toolbar">
      <legend className="sr-only">Trace 显示选项</legend>
      <Button
        variant="ghost"
        size="xs"
        aria-pressed={state.showDuration}
        onClick={() => dispatch({ type: 'toggle-duration' })}
      >
        <Clock3 data-icon="inline-start" /> 时长
      </Button>
      <Button
        variant="ghost"
        size="xs"
        aria-pressed={state.groupTurns}
        onClick={() => dispatch({ type: 'toggle-turn-groups' })}
      >
        <Layers2 data-icon="inline-start" /> 轮次
      </Button>
      <Button
        variant="ghost"
        size="xs"
        aria-pressed={callsExpanded}
        disabled={toolSteps.size === 0}
        onClick={() => dispatch({ type: 'toggle-calls', steps: toolSteps })}
      >
        <Wrench data-icon="inline-start" /> 调用
      </Button>
      <label className="trace-lane-filter">
        <ListFilter aria-hidden className="size-3" />
        <span className="sr-only">事件类型</span>
        <select
          value={state.lane}
          onChange={(event) =>
            dispatch({ type: 'lane', value: event.target.value as TraceViewState['lane'] })
          }
        >
          <option value="all">全部</option>
          <option value="input">输入</option>
          <option value="model">模型</option>
          <option value="tool">工具</option>
        </select>
      </label>
      <div className="trace-toolbar-actions">
        <Button
          variant="ghost"
          size="xs"
          title="切换时间线排列方式"
          aria-label="切换时间线排列方式"
          onClick={() =>
            dispatch({ type: 'mode', value: state.mode === 'sequence' ? 'duration' : 'sequence' })
          }
        >
          {state.mode === 'sequence' ? '顺序' : '耗时'}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={refreshing}
          aria-label="刷新历史事件"
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
        </Button>
        <div className="trace-search">
          <Search aria-hidden className="size-3" />
          <Input
            type="search"
            aria-label="搜索 Trace"
            placeholder="搜索"
            value={state.search}
            onChange={(event) => dispatch({ type: 'search', value: event.target.value })}
          />
          {state.search ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="清除搜索"
              onClick={() => dispatch({ type: 'search', value: '' })}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </div>
    </fieldset>
  );
}
