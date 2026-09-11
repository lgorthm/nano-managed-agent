import { useState } from "react";

/**
 * 游标分页状态。接口只返回 next_page(不透明游标),没有 prev_page,
 * "上一页"靠记录每一页的起始游标来回退。
 */
export function useCursorPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<(string | null)[]>([]);

  const page = history.length + 1;

  function goNext(nextCursor: string | null) {
    if (!nextCursor) return;
    setHistory((prev) => [...prev, cursor]);
    setCursor(nextCursor);
  }

  function goPrev() {
    if (history.length === 0) return;
    setCursor(history.at(-1) ?? null);
    setHistory((prev) => prev.slice(0, -1));
  }

  return { cursor, page, goNext, goPrev };
}
