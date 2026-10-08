import type { TimelineRange } from '@/lib/session-ledger';

export function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function orderedRange(start: number, end: number): TimelineRange {
  return start <= end ? { start, end } : { start: end, end: start };
}

export function centeredRange(
  center: number,
  width: number,
  minimum: number,
  maximum: number,
): TimelineRange {
  const boundedWidth = Math.min(maximum - minimum, Math.max(0, width));
  const start = Math.min(Math.max(center - boundedWidth / 2, minimum), maximum - boundedWidth);
  return { start, end: start + boundedWidth };
}
