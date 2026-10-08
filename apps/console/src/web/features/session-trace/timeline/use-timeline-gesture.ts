import { type KeyboardEvent, type MouseEvent, type PointerEvent, useRef, useState } from 'react';
import type { TimelineModel, TimelineRange, TimelineSpan } from '@/lib/session-ledger';
import { centeredRange, clampFraction, orderedRange } from './timeline-geometry';
import type { TimelineViewport } from './use-timeline-viewport';

const MINIMUM_DRAG_PX = 3;
const EDGE_ZONE_FRACTION = 0.08;
const EDGE_PAN_FRACTION = 0.025;
const MAXIMUM_EDGE_ZONE_PX = 32;

interface SelectionGesture {
  kind: 'selection';
  pointerId: number;
  anchorTime: number;
  anchorClientX: number;
  spanKey: string | null;
}

interface PanGesture {
  kind: 'pan';
  pointerId: number;
  anchorClientX: number;
  anchorStart: number;
  moved: boolean;
}

interface HoverPoint {
  fraction: number;
  spanKey: string | null;
}

interface TimelineGestureOptions {
  model: TimelineModel | null;
  viewport: TimelineViewport;
  range: TimelineRange | null;
  onRangeChange: (range: TimelineRange | null) => void;
  onItemSelect?: (key: string) => void;
  onItemFocus?: (key: string) => void;
}

function fractionAt(event: PointerEvent<HTMLDivElement>): number {
  const rect = event.currentTarget.getBoundingClientRect();
  return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
}

function spanKeyAt(event: PointerEvent<HTMLDivElement>): string | null {
  const target = event.target instanceof HTMLElement ? event.target : null;
  return target?.closest<HTMLElement>('[data-span-key]')?.dataset.spanKey ?? null;
}

function distanceToSpan(time: number, span: TimelineSpan): number {
  return time < span.start ? span.start - time : time > span.end ? time - span.end : 0;
}

/** One gesture can be active at a time: a left-button selection or a right-button pan. */
export function useTimelineGesture({
  model,
  viewport,
  range,
  onRangeChange,
  onItemSelect,
  onItemFocus,
}: TimelineGestureOptions) {
  const gestureRef = useRef<SelectionGesture | PanGesture | null>(null);
  const [draft, setDraft] = useState<TimelineRange | null>(null);
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const [panning, setPanning] = useState(false);

  const cancelGesture = () => {
    gestureRef.current = null;
    setDraft(null);
    setHover(null);
    setPanning(false);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!model || (event.button !== 0 && event.button !== 2)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.button === 2) {
      gestureRef.current = {
        kind: 'pan',
        pointerId: event.pointerId,
        anchorClientX: event.clientX,
        anchorStart: viewport.start,
        moved: false,
      };
      setPanning(true);
      return;
    }
    const fraction = fractionAt(event);
    const anchorTime = viewport.start + fraction * viewport.duration;
    const spanKey = spanKeyAt(event);
    gestureRef.current = {
      kind: 'selection',
      pointerId: event.pointerId,
      anchorTime,
      anchorClientX: event.clientX,
      spanKey,
    };
    setHover({ fraction, spanKey });
    setDraft({ start: anchorTime, end: anchorTime });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const fraction = fractionAt(event);
    setHover({ fraction, spanKey: spanKeyAt(event) });
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (gesture.kind === 'pan') {
      gesture.moved ||= Math.abs(event.clientX - gesture.anchorClientX) >= MINIMUM_DRAG_PX;
      if (viewport.zoomed) {
        const delta = (event.clientX - gesture.anchorClientX) / Math.max(1, rect.width);
        viewport.moveTo(gesture.anchorStart - delta * viewport.duration);
      }
      return;
    }
    let nextStart = viewport.start;
    if (viewport.zoomed) {
      const localX = event.clientX - rect.left;
      const edgeWidth = Math.min(
        MAXIMUM_EDGE_ZONE_PX,
        Math.max(1, rect.width * EDGE_ZONE_FRACTION),
      );
      const direction = localX < edgeWidth ? -1 : localX > rect.width - edgeWidth ? 1 : 0;
      if (direction !== 0) {
        const edgeDistance = direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth);
        const strength = Math.max(0.2, clampFraction(edgeDistance / edgeWidth));
        nextStart = viewport.moveTo(
          viewport.start + direction * viewport.duration * EDGE_PAN_FRACTION * strength,
        );
      }
    }
    setDraft(orderedRange(gesture.anchorTime, nextStart + fraction * viewport.duration));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!model || !gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    gestureRef.current = null;
    if (gesture.kind === 'pan') {
      setPanning(false);
      if (!gesture.moved && Math.abs(event.clientX - gesture.anchorClientX) < MINIMUM_DRAG_PX) {
        onRangeChange(null);
      }
      return;
    }
    setDraft(null);
    const fraction = fractionAt(event);
    const time = viewport.start + fraction * viewport.duration;
    const selection = orderedRange(gesture.anchorTime, time);
    const isClick = Math.abs(event.clientX - gesture.anchorClientX) < MINIMUM_DRAG_PX;
    if (isClick && gesture.spanKey !== null) {
      onRangeChange(null);
      onItemSelect?.(gesture.spanKey);
      return;
    }
    const minimumWidth = Math.min(
      viewport.duration,
      viewport.fullDuration / Math.max(1, model.spans.length),
    );
    onRangeChange(
      selection.end - selection.start < minimumWidth
        ? centeredRange(
            isClick ? selection.start : (selection.start + selection.end) / 2,
            minimumWidth,
            model.start,
            model.start + viewport.fullDuration,
          )
        : selection,
    );
    if (isClick && model.spans.length > 0) {
      const nearest = model.spans.reduce((candidate, span) =>
        distanceToSpan(time, span) < distanceToSpan(time, candidate) ? span : candidate,
      );
      onItemFocus?.(nearest.key);
    }
  };

  return {
    draft,
    hover,
    panning,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: cancelGesture,
      onPointerLeave() {
        if (gestureRef.current === null) setHover(null);
      },
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key !== 'Escape') return;
        if (range !== null || draft !== null) {
          event.preventDefault();
          cancelGesture();
          onRangeChange(null);
        }
      },
      onDoubleClick(event: MouseEvent<HTMLDivElement>) {
        event.preventDefault();
        onRangeChange(null);
      },
      onContextMenu(event: MouseEvent<HTMLDivElement>) {
        event.preventDefault();
      },
    },
  };
}
