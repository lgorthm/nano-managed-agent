import { type RefObject, useEffect, useRef, useState } from 'react';
import type { TimelineMode, TimelineModel, TimelineRange } from '@/lib/session-ledger';
import { clampFraction } from './timeline-geometry';

const MINIMUM_SEQUENCE_WIDTH = 4;
const MINIMUM_DURATION_MS = 500;

export interface TimelineViewport {
  start: number;
  duration: number;
  fullDuration: number;
  zoomed: boolean;
  animate: boolean;
  moveTo(start: number): number;
  reset(): void;
}

interface ViewportState {
  mode: TimelineMode;
  range: TimelineRange;
}

/** Viewport state is independent from the controlled record-selection range. */
export function useTimelineViewport(
  model: TimelineModel | null,
  mode: TimelineMode,
  selectedKey: string | null,
  trackRef: RefObject<HTMLDivElement | null>,
): TimelineViewport {
  const [state, setState] = useState<ViewportState | null>(null);
  const [animate, setAnimate] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
  const minimumDuration = Math.min(
    fullDuration,
    mode === 'sequence'
      ? MINIMUM_SEQUENCE_WIDTH
      : Math.max(MINIMUM_DURATION_MS, fullDuration * 0.02),
  );
  const storedRange = state?.mode === mode ? state.range : null;
  const duration =
    storedRange === null
      ? fullDuration
      : Math.min(fullDuration, Math.max(minimumDuration, storedRange.end - storedRange.start));
  const minimum = model?.start ?? 0;
  const maximumStart = minimum + fullDuration - duration;
  const start = Math.min(Math.max(storedRange?.start ?? minimum, minimum), maximumStart);
  const zoomed = storedRange !== null && duration < fullDuration;

  useEffect(() => {
    const track = trackRef.current;
    if (!track || !model) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = track.getBoundingClientRect();
      const anchor = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
      const nextDuration = Math.min(
        fullDuration,
        Math.max(minimumDuration, duration * Math.exp(event.deltaY * 0.0015)),
      );
      setAnimate(false);
      if (nextDuration >= fullDuration * 0.999) {
        setState(null);
        return;
      }
      const anchorTime = start + anchor * duration;
      const nextStart = Math.min(
        Math.max(anchorTime - anchor * nextDuration, minimum),
        minimum + fullDuration - nextDuration,
      );
      setState({ mode, range: { start: nextStart, end: nextStart + nextDuration } });
    };
    track.addEventListener('wheel', onWheel, { passive: false });
    return () => track.removeEventListener('wheel', onWheel);
  }, [duration, fullDuration, minimum, minimumDuration, mode, model, start, trackRef]);

  // Only a new selection can reveal a block. Live data and manual panning do not pull the view back.
  useEffect(() => {
    if (selectedRef.current === selectedKey) return;
    selectedRef.current = selectedKey;
    if (!model || !selectedKey || !zoomed) return;
    const span = model.spans.find((item) => item.key === selectedKey);
    if (!span || (span.end >= start && span.start <= start + duration)) return;
    const desiredStart = span.end < start ? span.start : span.end - duration;
    const nextStart = Math.min(Math.max(desiredStart, minimum), maximumStart);
    setAnimate(true);
    setState({ mode, range: { start: nextStart, end: nextStart + duration } });
  }, [duration, maximumStart, minimum, mode, model, selectedKey, start, zoomed]);

  return {
    start,
    duration,
    fullDuration,
    zoomed,
    animate,
    moveTo(desiredStart) {
      const nextStart = Math.min(Math.max(desiredStart, minimum), maximumStart);
      setAnimate(false);
      setState({ mode, range: { start: nextStart, end: nextStart + duration } });
      return nextStart;
    },
    reset() {
      setAnimate(false);
      setState(null);
    },
  };
}
