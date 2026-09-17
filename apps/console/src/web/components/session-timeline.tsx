/**
 * 会话事件交互式时间线(Chrome DevTools Network 风格总览):
 * 三泳道按当前投影模式(顺序/耗时)铺开,支持左键拖选区间聚焦台账、滚轮缩放(锚定鼠标位置)、
 * 右键拖动平移、拖选靠近边缘时自动边缘平移;左键单击块选中事件、单击空白聚焦最近事件,
 * Escape/双击/右键单击清除选区。选中事件不在当前视口时自动平移视口。
 * 选区(range)为受控状态由页面持有,驱动台账行「选区外压暗」;缩放平移视口(viewport)
 * 为组件内部状态,两者分离——参考 ui-trajectory 的 TrajectoryTimeline 实现方法。
 * span 相对全域定位、放大 lanes 容器实现缩放:缩放平移只改容器 style,块位置不重算。
 */
import {
  type CSSProperties,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  formatSpanDuration,
  type LedgerLane,
  type TimelineMode,
  type TimelineModel,
  type TimelineRange,
} from '@/lib/session-ledger';
import { cn } from '@/lib/utils';

/** 拖选位移小于该像素数视为单击 */
const MINIMUM_DRAG_PX = 3;
/** sequence 模式最小视口宽度(条数) */
const MINIMUM_SEQUENCE_ZOOM = 4;
/** duration 模式最小视口宽度(取全长的 2%,至少 500ms) */
const MINIMUM_DURATION_ZOOM_MS = 500;
/** 拖选中靠近轨道两侧该比例区域时按步平移视口 */
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_STEP_FRACTION = 0.025;
const MAXIMUM_EDGE_PAN_PX = 32;
/** 泳道轨道高度与三条泳道的垂直位置 */
const TRACK_HEIGHT_PX = 50;
const LANE_TOP: Record<LedgerLane, number> = { input: 3, model: 19, tool: 35 };
const LANE_BLOCK: Record<LedgerLane, string> = {
  input: 'bg-chart-5/70',
  model: 'bg-chart-1/70',
  tool: 'bg-chart-4/70',
};
const LANE_LABELS: Array<{ id: LedgerLane; label: string }> = [
  { id: 'input', label: '输入' },
  { id: 'model', label: '模型' },
  { id: 'tool', label: '工具' },
];

interface DragGesture {
  pointerId: number;
  anchorTime: number;
  anchorClientX: number;
  spanKey: string | null;
}

interface PanGesture {
  anchorClientX: number;
  anchorStart: number;
  moved: boolean;
  pannable: boolean;
  pointerId: number;
}

interface HoverPoint {
  fraction: number;
  spanKey: string | null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function orderedRange(start: number, end: number): TimelineRange {
  return start <= end ? { start, end } : { start: end, end: start };
}

/** 以 center 为中心、宽度 width 的区间,夹在 [minimum, maximum] 内 */
function centeredRange(
  center: number,
  width: number,
  minimum: number,
  maximum: number,
): TimelineRange {
  const clampedWidth = Math.min(maximum - minimum, Math.max(0, width));
  const start = Math.min(Math.max(center - clampedWidth / 2, minimum), maximum - clampedWidth);
  return { start, end: start + clampedWidth };
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export interface SessionTimelineProps {
  model: TimelineModel | null;
  mode: TimelineMode;
  /** 受控选区:提交后驱动台账聚焦,页面持有 */
  range: TimelineRange | null;
  onRangeChange: (range: TimelineRange | null) => void;
  selectedKey?: string | null;
  /** 搜索命中的 key 集合;非空时命中外的块压暗 */
  searchMatchKeys?: ReadonlySet<string> | null;
  /** 泳道筛选:非该泳道的块压暗(时间线轴始终取全量,保证选区稳定) */
  laneFilter?: LedgerLane | 'all';
  /** 左键单击块:选中事件 */
  onItemSelect?: (key: string) => void;
  /** 左键单击空白:聚焦最近的事件 */
  onItemFocus?: (key: string) => void;
  className?: string;
}

export const SessionTimeline = memo(function SessionTimeline({
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
}: SessionTimelineProps) {
  const dragRef = useRef<DragGesture | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<TimelineRange | null>(null);
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const [hoveredSpan, setHoveredSpan] = useState<TimelineModel['spans'][number] | null>(null);
  const [panning, setPanning] = useState(false);
  const [viewport, setViewport] = useState<TimelineRange | null>(null);
  const [animateViewport, setAnimateViewport] = useState(false);

  // 新数据或模式切换导致投影域变化时,越界的选区与视口自动复位
  useEffect(() => {
    if (model !== null && range !== null && (range.end < model.start || range.start > model.end)) {
      onRangeChange(null);
    }
  }, [model, onRangeChange, range]);
  useEffect(() => {
    if (model === null) return;
    setViewport((current) =>
      current !== null && (current.end < model.start || current.start > model.end) ? null : current,
    );
  }, [model]);

  // 选中事件不在当前视口内时自动平移视口(保持缩放级别,带过渡动画)
  useEffect(() => {
    if (model === null || selectedKey === null) return;
    const span = model.spans.find((item) => item.key === selectedKey);
    if (span === undefined) return;
    setAnimateViewport(true);
    setViewport((current) => {
      if (current === null) return current;
      if (span.end > current.start && span.start < current.end) return current;
      const duration = Math.max(1, current.end - current.start);
      const desiredStart = span.end <= current.start ? span.start : span.end - duration;
      const nextStart = Math.min(
        Math.max(desiredStart, model.start),
        Math.max(model.start, model.end - duration),
      );
      if (nextStart === current.start) return current;
      return { start: nextStart, end: nextStart + duration };
    });
  }, [model, selectedKey]);

  const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
  const minDuration =
    model === null
      ? 1
      : Math.min(
          fullDuration,
          mode === 'sequence'
            ? Math.min(MINIMUM_SEQUENCE_ZOOM, fullDuration)
            : Math.max(MINIMUM_DURATION_ZOOM_MS, fullDuration * 0.02),
        );
  const viewportDuration = Math.min(
    fullDuration,
    Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)),
  );
  const domainStart =
    model === null || viewport === null
      ? (model?.start ?? 0)
      : Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration);
  const domainDuration = viewport === null ? fullDuration : viewportDuration;
  const activeRange = draft ?? range;

  // 滚轮缩放必须是非 passive 监听(要 preventDefault),React 合成事件不可用
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onWheel = (event: globalThis.WheelEvent): void => {
      event.preventDefault();
      const track = trackRef.current;
      if (track === null || model === null) return;
      setAnimateViewport(false);
      const rect = track.getBoundingClientRect();
      const anchorFraction = clamp01((event.clientX - rect.left) / Math.max(1, rect.width));
      const nextDuration = Math.min(
        fullDuration,
        Math.max(minDuration, domainDuration * Math.exp(event.deltaY * 0.0015)),
      );
      if (nextDuration >= fullDuration * 0.999) {
        setViewport(null);
        return;
      }
      const anchorTime = domainStart + anchorFraction * domainDuration;
      const nextStart = Math.min(
        Math.max(anchorTime - anchorFraction * nextDuration, model.start),
        model.end - nextDuration,
      );
      setViewport({ start: nextStart, end: nextStart + nextDuration });
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      root.removeEventListener('wheel', onWheel);
    };
  }, [domainDuration, domainStart, fullDuration, minDuration, model]);

  if (model === null) return null;

  // 视口外的块不渲染(选中块除外),深缩放时控制 DOM 数量
  const visibleSpans = model.spans.filter(
    (span) =>
      span.key === selectedKey ||
      (span.end >= domainStart && span.start <= domainStart + domainDuration),
  );
  // 单击空白时的最小选宽:不低于单块平均宽度,避免点击即选中全部
  const minimumSelectionDuration = Math.min(domainDuration, fullDuration / model.spans.length);
  // lanes 容器相对全域放大:块按全域百分比定位,缩放平移只改这一个 style
  const projectedDomainStyle = {
    left: `${(-(domainStart - model.start) / domainDuration) * 100}%`,
    width: `${(fullDuration / domainDuration) * 100}%`,
  } as CSSProperties;

  const fractionAt = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clamp01((event.clientX - rect.left) / Math.max(1, rect.width));
  };

  const spanKeyAt = (event: ReactPointerEvent<HTMLDivElement>): string | null => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    return target?.closest<HTMLElement>('[data-span-key]')?.dataset.spanKey ?? null;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      panRef.current = {
        anchorClientX: event.clientX,
        anchorStart: domainStart,
        moved: false,
        pannable: viewport !== null,
        pointerId: event.pointerId,
      };
      if (viewport !== null) setAnimateViewport(false);
      setPanning(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const anchor = fractionAt(event);
    const anchorTime = domainStart + anchor * domainDuration;
    const spanKey = spanKeyAt(event);
    setHover({ fraction: anchor, spanKey });
    dragRef.current = {
      pointerId: event.pointerId,
      anchorTime,
      anchorClientX: event.clientX,
      spanKey,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDraft({ start: anchorTime, end: anchorTime });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const fraction = fractionAt(event);
    setHover({ fraction, spanKey: spanKeyAt(event) });
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) {
        pan.moved = true;
      }
      if (!pan.pannable) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
      const nextStart = Math.min(
        Math.max(pan.anchorStart - delta * domainDuration, model.start),
        model.end - domainDuration,
      );
      setViewport({ start: nextStart, end: nextStart + domainDuration });
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    let nextDomainStart = domainStart;
    if (viewport !== null) {
      // 拖选接近轨道两侧时按步平移视口,强度随贴近程度加深
      const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
      const rectWidth = event.currentTarget.getBoundingClientRect().width;
      const edgeWidth = Math.min(
        MAXIMUM_EDGE_PAN_PX,
        Math.max(1, rectWidth * EDGE_PAN_ZONE_FRACTION),
      );
      const direction = localX < edgeWidth ? -1 : localX > rectWidth - edgeWidth ? 1 : 0;
      if (direction !== 0) {
        const edgeDistance = direction < 0 ? edgeWidth - localX : localX - (rectWidth - edgeWidth);
        const strength = clamp01(edgeDistance / edgeWidth);
        const desiredStart =
          domainStart +
          direction * domainDuration * EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength);
        nextDomainStart = Math.min(Math.max(desiredStart, model.start), model.end - domainDuration);
        if (nextDomainStart !== domainStart) {
          setAnimateViewport(false);
          setViewport({
            start: nextDomainStart,
            end: nextDomainStart + domainDuration,
          });
        }
      }
    }
    const pointTime = nextDomainStart + fraction * domainDuration;
    setDraft(orderedRange(drag.anchorTime, pointTime));
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
      panRef.current = null;
      setPanning(false);
      if (!moved) onRangeChange(null); // 右键单击清除选区
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointFraction = fractionAt(event);
    const pointTime = domainStart + pointFraction * domainDuration;
    const selected = orderedRange(drag.anchorTime, pointTime);
    setHover({ fraction: pointFraction, spanKey: spanKeyAt(event) });
    dragRef.current = null;
    setDraft(null);
    const isClick = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
    if (isClick && drag.spanKey !== null) {
      onRangeChange(null);
      onItemSelect?.(drag.spanKey);
      return;
    }
    const committed =
      selected.end - selected.start < minimumSelectionDuration
        ? centeredRange(
            isClick ? selected.start : (selected.start + selected.end) / 2,
            minimumSelectionDuration,
            model.start,
            model.end,
          )
        : selected;
    onRangeChange(committed);
    if (isClick) {
      // 单击空白:聚焦距离点击位置最近的块
      const nearest = model.spans.reduce((candidate, span) => {
        const distanceOf = (item: { start: number; end: number }): number =>
          pointTime < item.start
            ? item.start - pointTime
            : pointTime > item.end
              ? pointTime - item.end
              : 0;
        return distanceOf(span) < distanceOf(candidate) ? span : candidate;
      });
      onItemFocus?.(nearest.key);
    }
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    panRef.current = null;
    setDraft(null);
    setHover(null);
    setPanning(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || range === null) return;
    event.preventDefault();
    onRangeChange(null);
  };

  // 选区相对当前视口的百分比(供高亮层定位)
  const boundedRange = activeRange
    ? orderedRange(
        Math.min(Math.max(activeRange.start, model.start), model.end),
        Math.min(Math.max(activeRange.end, model.start), model.end),
      )
    : null;
  const rangeStyle = boundedRange
    ? {
        left: `${((boundedRange.start - domainStart) / domainDuration) * 100}%`,
        width: `${((boundedRange.end - boundedRange.start) / domainDuration) * 100}%`,
      }
    : null;

  return (
    <section ref={rootRef} className={cn('relative', className)} aria-label="会话事件时间线总览">
      <div className="flex items-start gap-2">
        <div className="w-9 shrink-0 pt-[3px]" aria-hidden>
          {LANE_LABELS.map((lane, index) => (
            <span
              key={lane.id}
              className="text-muted-foreground block text-right text-xs leading-[14px]"
              style={{ marginBottom: index < LANE_LABELS.length - 1 ? 3 : 0 }}
            >
              {lane.label}
            </span>
          ))}
        </div>
        <div
          ref={trackRef}
          role="img"
          className={cn(
            'bg-muted/40 relative grow touch-pan-y cursor-crosshair overflow-hidden rounded-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
            panning && 'cursor-grabbing',
          )}
          style={{ height: TRACK_HEIGHT_PX }}
          aria-label="拖选区间聚焦事件;滚轮缩放;右键拖动平移;Escape 清除选区"
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            if (dragRef.current === null && panRef.current === null) {
              setHover(null);
              setHoveredSpan(null);
            }
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRangeChange(null);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
          }}
        >
          {/* 三条泳道底轨 */}
          {LANE_LABELS.map((lane) => (
            <span
              key={lane.id}
              aria-hidden
              className="bg-muted/60 absolute h-2 w-full rounded-sm"
              style={{ top: LANE_TOP[lane.id] }}
            />
          ))}

          {/* 选区高亮(渲染在最底层):边线 + 淡底标出区间,块浮在上面保持原色 */}
          {rangeStyle ? (
            <span
              aria-hidden
              data-dragging={draft === null ? undefined : 'true'}
              className={cn(
                'pointer-events-none absolute inset-y-0 border-x-2',
                draft === null
                  ? 'border-foreground/50 bg-foreground/[0.07]'
                  : 'border-foreground/70 bg-foreground/[0.12]',
              )}
              style={rangeStyle}
            />
          ) : null}

          {/* turn 边界竖线(全域定位,随容器缩放平移) */}
          <div
            aria-hidden
            className="absolute inset-y-0 motion-reduce:transition-none"
            style={{
              ...projectedDomainStyle,
              transition: animateViewport ? 'left 180ms ease' : undefined,
            }}
          >
            {model.turnBoundaries
              .filter(
                (boundary) =>
                  boundary.time > model.start &&
                  boundary.time >= domainStart &&
                  boundary.time <= domainStart + domainDuration,
              )
              .map((boundary) => (
                <span
                  key={boundary.turn}
                  title={`Turn ${boundary.turn}`}
                  className="absolute inset-y-0 w-px -translate-x-1/2 cursor-help bg-foreground/15 hover:bg-foreground/40"
                  style={{
                    left: `${((boundary.time - model.start) / fullDuration) * 100}%`,
                  }}
                />
              ))}
          </div>

          {/* 事件块(全域定位) */}
          <div
            data-timeline-domain
            aria-hidden
            className="absolute inset-y-0 motion-reduce:transition-none"
            style={{
              ...projectedDomainStyle,
              transition: animateViewport ? 'left 180ms ease' : undefined,
            }}
          >
            {visibleSpans.map((span) => {
              const left = (span.start - model.start) / fullDuration;
              const width = Math.max((span.end - span.start) / fullDuration, 0.002);
              const outsideFocus =
                activeRange !== null &&
                !(span.start <= activeRange.end && span.end >= activeRange.start);
              const outsideSearch = searchMatchKeys !== null && !searchMatchKeys.has(span.key);
              const outsideLane = laneFilter !== 'all' && span.lane !== laneFilter;
              const selected = span.key === selectedKey;
              return (
                <span
                  key={span.key}
                  data-span-key={span.key}
                  className={cn(
                    'absolute h-2 min-w-[5px] rounded-sm',
                    span.isError ? 'bg-destructive/80' : LANE_BLOCK[span.lane],
                    hoveredSpan?.key === span.key && 'brightness-125',
                    selected && 'outline-foreground/70 z-10 outline-2 outline-offset-1',
                    (outsideFocus || outsideSearch || outsideLane) &&
                      hoveredSpan?.key !== span.key &&
                      'opacity-25',
                  )}
                  style={{
                    top: LANE_TOP[span.lane],
                    left: `${left * 100}%`,
                    width: `${width * 100}%`,
                  }}
                  onPointerEnter={() => setHoveredSpan(span)}
                  onPointerLeave={() => setHoveredSpan(null)}
                />
              );
            })}
          </div>

          {/* hover 垂直线(空白处) */}
          {hover !== null && hover.spanKey === null && draft === null && !panning ? (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-foreground/25"
              style={{ left: `${hover.fraction * 100}%` }}
            />
          ) : null}
        </div>
      </div>

      {/* 块 tooltip:事件名/摘要/真实时间区间/耗时 */}
      {hoveredSpan ? (
        <div
          role="tooltip"
          className="bg-foreground text-background pointer-events-none absolute top-0 z-20 w-max max-w-72 rounded-md px-3 py-2 text-xs shadow-lg"
          style={{
            left: `calc(2.75rem + ${Math.min(
              Math.max(((hoveredSpan.start - domainStart) / domainDuration) * 100, 6),
              80,
            )}%)`,
          }}
        >
          <div className="font-medium">
            {hoveredSpan.label}
            {hoveredSpan.summary && hoveredSpan.summary !== hoveredSpan.label ? (
              <span className="opacity-70"> · {hoveredSpan.summary.slice(0, 60)}</span>
            ) : null}
          </div>
          <div className="mt-0.5 tabular-nums opacity-80">Turn {hoveredSpan.turn}</div>
          <div className="tabular-nums opacity-80">
            {formatClock(hoveredSpan.startedAt ?? 0)}
            {hoveredSpan.durationMs
              ? ` ~ ${formatClock((hoveredSpan.startedAt ?? 0) + hoveredSpan.durationMs)}`
              : ''}
          </div>
          <div className="tabular-nums opacity-80">
            总计 {formatSpanDuration(hoveredSpan.durationMs ?? 0)}
            {hoveredSpan.isError ? ' · 失败' : ''}
          </div>
        </div>
      ) : null}

      {/* 底部信息:视口状态 + 事件计数 + 操作提示 */}
      <div className="text-muted-foreground mt-1.5 flex items-center justify-between pl-[2.75rem] text-[11px] tabular-nums">
        <span>
          {viewport === null
            ? `${model.spans.length} 个事件`
            : `已缩放 · ${Math.round((domainDuration / fullDuration) * 100)}%`}
          {model.turnBoundaries.length > 0 ? ` · ${model.turnBoundaries.length} 轮` : ''}
        </span>
        <span className="flex items-center gap-2">
          {viewport !== null ? (
            <button
              type="button"
              className="hover:text-foreground rounded px-1 underline-offset-2 hover:underline"
              onClick={() => {
                setAnimateViewport(false);
                setViewport(null);
              }}
            >
              复位
            </button>
          ) : null}
          <span className="hidden sm:inline">拖选聚焦 · 滚轮缩放 · 右键平移</span>
        </span>
      </div>
    </section>
  );
});
