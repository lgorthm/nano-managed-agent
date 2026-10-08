// biome-ignore-all lint/a11y/useSemanticElements: The pointer-operated timeline is an interactive group, rather than a form fieldset.
import { RotateCcw } from 'lucide-react';
import { type CSSProperties, memo, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  formatSpanDuration,
  type LedgerLane,
  type TimelineMode,
  type TimelineModel,
  type TimelineRange,
  type TimelineSpan,
} from '@/lib/session-ledger';
import { cn } from '@/lib/utils';
import type { TraceTone } from '../components/trace-label';
import { useTimelineGesture } from './use-timeline-gesture';
import { useTimelineViewport } from './use-timeline-viewport';

const TRACK_HEIGHT = 44;
const LANES: readonly { id: LedgerLane; label: string; top: number }[] = [
  { id: 'input', label: '输入', top: 5 },
  { id: 'model', label: '模型', top: 18 },
  { id: 'tool', label: '工具', top: 31 },
];
const LANE_TOP: Record<LedgerLane, number> = { input: 5, model: 18, tool: 31 };

export interface TraceTimelineProps {
  model: TimelineModel | null;
  mode: TimelineMode;
  range: TimelineRange | null;
  onRangeChange: (range: TimelineRange | null) => void;
  selectedKey?: string | null;
  searchMatchKeys?: ReadonlySet<string> | null;
  laneFilter?: LedgerLane | 'all';
  onItemSelect?: (key: string) => void;
  onItemFocus?: (key: string) => void;
  className?: string;
}

function toneOfSpan(span: TimelineSpan): TraceTone {
  if (span.isError) return 'error';
  if (span.kind === 'system') return 'context';
  if (span.kind === 'user') return 'user';
  if (span.kind === 'tool') return 'tool';
  return 'assistant';
}

function formatClock(time: number): string {
  return new Date(time).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function TimelineTooltip({ span }: { span: TimelineSpan }) {
  return (
    <div className="trace-timeline-tooltip">
      <p>{span.label}</p>
      {span.summary !== span.label ? <p className="max-w-72 truncate">{span.summary}</p> : null}
      <p>第 {span.turn} 轮</p>
      {span.startedAt !== null ? <p>{formatClock(span.startedAt)}</p> : null}
      <p>
        {span.durationMs === null ? '进行中' : formatSpanDuration(span.durationMs)}
        {span.isError ? ' · 失败' : ''}
      </p>
    </div>
  );
}

/** The overview projects records; hooks separately own viewport and pointer gestures. */
export const TraceTimeline = memo(function TraceTimeline({
  model,
  mode,
  range,
  onRangeChange,
  selectedKey = null,
  searchMatchKeys = null,
  laneFilter = 'all',
  onItemSelect,
  onItemFocus,
  className,
}: TraceTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hoveredSpan, setHoveredSpan] = useState<TimelineSpan | null>(null);
  const viewport = useTimelineViewport(model, mode, selectedKey, trackRef);
  const gesture = useTimelineGesture({
    model,
    viewport,
    range,
    onRangeChange,
    onItemSelect,
    onItemFocus,
  });

  useEffect(() => {
    if (model && range && (range.end < model.start || range.start > model.end)) {
      onRangeChange(null);
    }
  }, [model, onRangeChange, range]);

  if (!model) return null;
  const activeRange = gesture.draft ?? range;
  const visibleSpans = model.spans.filter(
    (span) =>
      span.key === selectedKey ||
      (span.end >= viewport.start && span.start <= viewport.start + viewport.duration),
  );
  const domainStyle: CSSProperties = {
    position: 'absolute',
    insetBlock: 0,
    left: `${(-(viewport.start - model.start) / viewport.duration) * 100}%`,
    width: `${(viewport.fullDuration / viewport.duration) * 100}%`,
    transition: viewport.animate ? 'left var(--trace-viewport-transition, 180ms) ease' : undefined,
  };
  const rangeStyle: CSSProperties | undefined = activeRange
    ? {
        left: `${((activeRange.start - viewport.start) / viewport.duration) * 100}%`,
        width: `${((activeRange.end - activeRange.start) / viewport.duration) * 100}%`,
      }
    : undefined;
  const tooltipLeft = hoveredSpan
    ? Math.min(
        98,
        Math.max(
          0,
          (((hoveredSpan.start + hoveredSpan.end) / 2 - viewport.start) / viewport.duration) * 100,
        ),
      )
    : 0;

  return (
    <section className={cn('trace-timeline', className)} aria-label="Trace 时间线总览">
      <div className="trace-timeline-labels" aria-hidden>
        {LANES.map((lane) => (
          <span key={lane.id} style={{ top: lane.top }}>
            {lane.label}
          </span>
        ))}
      </div>
      <div
        ref={trackRef}
        role="group"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The timeline accepts Escape to clear its selection.
        tabIndex={0}
        className={cn('trace-timeline-track', gesture.panning && 'trace-timeline-panning')}
        style={{ height: TRACK_HEIGHT }}
        aria-label="拖动选择区间；滚轮缩放；右键拖动平移；按 Escape 清除选区"
        {...gesture.handlers}
        onPointerLeave={() => {
          gesture.handlers.onPointerLeave();
          setHoveredSpan(null);
        }}
      >
        {LANES.map((lane) => (
          <span
            key={lane.id}
            aria-hidden
            className="trace-timeline-lane"
            style={{ top: lane.top }}
          />
        ))}
        {activeRange ? (
          <span
            aria-hidden
            className="trace-timeline-selection"
            data-dragging={gesture.draft !== null || undefined}
            style={rangeStyle}
          />
        ) : null}
        <div aria-hidden className="trace-timeline-domain" style={domainStyle}>
          {model.turnBoundaries
            .filter(
              (boundary) =>
                boundary.time > model.start &&
                boundary.time >= viewport.start &&
                boundary.time <= viewport.start + viewport.duration,
            )
            .map((boundary) => (
              <span
                key={boundary.turn}
                className="trace-timeline-turn-boundary"
                style={{
                  left: `${((boundary.time - model.start) / viewport.fullDuration) * 100}%`,
                }}
                title={`第 ${boundary.turn} 轮`}
              />
            ))}
        </div>
        <div aria-hidden data-timeline-domain className="trace-timeline-domain" style={domainStyle}>
          {visibleSpans.map((span) => {
            const outsideRange =
              activeRange !== null &&
              !(span.start <= activeRange.end && span.end >= activeRange.start);
            const outsideSearch = searchMatchKeys !== null && !searchMatchKeys.has(span.key);
            const outsideLane = laneFilter !== 'all' && span.lane !== laneFilter;
            const width = Math.max((span.end - span.start) / viewport.fullDuration, 0.002);
            return (
              <span
                key={span.key}
                data-span-key={span.key}
                data-tone={toneOfSpan(span)}
                data-selected={span.key === selectedKey || undefined}
                className={cn(
                  'trace-timeline-block',
                  (outsideRange || outsideSearch || outsideLane) && 'trace-timeline-block-dimmed',
                )}
                style={{
                  top: LANE_TOP[span.lane],
                  left: `${((span.start - model.start) / viewport.fullDuration) * 100}%`,
                  width: `calc(${width * 100}% - 2px)`,
                }}
                onPointerEnter={() => setHoveredSpan(span)}
                onPointerLeave={() => setHoveredSpan(null)}
              />
            );
          })}
        </div>
        {gesture.hover && !gesture.hover.spanKey && !gesture.draft && !gesture.panning ? (
          <span
            aria-hidden
            className="trace-timeline-hover-line"
            style={{ left: `${gesture.hover.fraction * 100}%` }}
          />
        ) : null}
        <TooltipProvider>
          <Tooltip open={hoveredSpan !== null && !gesture.draft && !gesture.panning}>
            <TooltipTrigger asChild>
              <span
                aria-hidden
                className="trace-timeline-tooltip-anchor"
                style={{ left: `${tooltipLeft}%` }}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start" sideOffset={8}>
              {hoveredSpan ? <TimelineTooltip span={hoveredSpan} /> : null}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {viewport.zoomed ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="trace-timeline-reset"
          aria-label="恢复时间线的完整视图"
          title="恢复完整视图"
          onClick={viewport.reset}
        >
          <RotateCcw aria-hidden />
        </Button>
      ) : null}
    </section>
  );
});
