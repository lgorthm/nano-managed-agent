import { useState } from 'react';

/**
 * 游标分页状态,兼容两种翻页协议:opaque page 游标(sessions/environments 的
 * next_page)与资源 ID 游标(files 的 last_id/first_id,配 after_id/before_id)。
 * "上一页"靠记录每一页的起始游标来回退;筛选条件变化时用 reset 回到第一页。
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

  function reset() {
    setCursor(null);
    setHistory([]);
  }

  return { cursor, page, goNext, goPrev, reset };
}
