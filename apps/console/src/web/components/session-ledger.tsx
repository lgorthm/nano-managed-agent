/**
 * 会话事件台账(Chrome DevTools Network 风格):紧凑单行表格,按 turn 分组画竖轨,
 * 每行一个事件或一条折叠摘要;点击行选中事件(联动右侧详情面板),双击或点击摘要行切换折叠。
 * 行数组由 collapseRecords 纯函数产出(折叠即数据变换),本组件只做虚拟化渲染(@tanstack/react-virtual),
 * 不感知折叠集合;贴底跟随/选中滚动/选区滚动通过 ref 命令式 API 暴露给页面 effect 调用。
 * 虚拟化采用 table 语义 + 首尾空行占位;逻辑行号(aria-rowindex)在折叠/过滤/虚拟化下保持连续。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Brain, Info, Sparkles, TriangleAlert, User, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatSpanDuration,
  type LedgerKind,
  type LedgerRow,
} from "@/lib/session-ledger";

/** 台账对页面的命令式通道:页面 effect 在选中/选区/新事件到达时调用 */
export interface SessionLedgerHandle {
  /** 把某条记录滚进行视口(被折叠时回调 onRevealKey 由页面展开) */
  scrollToKey(key: string): void;
  /** 选区提交后滚动到聚焦行:聚焦段高于视口时顶对齐,否则居中 */
  scrollToFocus(keys: ReadonlySet<string>): void;
  /** 贴底状态下滚到最新行 */
  followTail(): void;
  /** 强制恢复贴底并滚到最新行(切回事件流 tab 时重置跟随) */
  jumpToTail(): void;
}

interface KindStyle {
  icon: typeof User;
  text: string;
  className: string;
}

const KIND_STYLES: Record<LedgerKind, KindStyle> = {
  user: { icon: User, text: "用户", className: "bg-chart-5/15 text-chart-5" },
  system: { icon: Info, text: "系统", className: "bg-muted text-muted-foreground" },
  message: { icon: Sparkles, text: "消息", className: "bg-chart-1/10 text-chart-1" },
  thinking: { icon: Brain, text: "思考", className: "bg-chart-1/10 text-chart-1" },
  tool: { icon: Wrench, text: "工具", className: "bg-chart-4/15 text-chart-4" },
  span: { icon: Sparkles, text: "请求", className: "bg-chart-1/10 text-chart-1" },
  error: { icon: TriangleAlert, text: "错误", className: "bg-destructive/12 text-destructive" },
};

function KindTag({ kind }: { kind: LedgerKind }) {
  const style = KIND_STYLES[kind];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex h-[19px] items-center gap-1 rounded-full px-1.5 text-[10px] leading-none font-medium",
        style.className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {style.text}
    </span>
  );
}

function DurationCell({ row }: { row: LedgerRow }) {
  if (!row.record) return null;
  const { durationMs, startedAt, endAt } = row.record;
  if (startedAt === null) {
    return <span className="text-muted-foreground/70 text-[11px]">排队中</span>;
  }
  if (durationMs === null || endAt === null) {
    return <span className="text-muted-foreground/70 text-[11px]">进行中</span>;
  }
  return (
    <span
      className={cn(
        "text-[11px] tabular-nums",
        durationMs >= 1000 ? "text-foreground/80" : "text-muted-foreground",
      )}
      title={durationMs > 0 ? `耗时 ${formatSpanDuration(durationMs)}` : "瞬时事件"}
    >
      {durationMs > 0 ? formatSpanDuration(durationMs) : "—"}
    </span>
  );
}

/** 点击时命中活动文本选择则不当作行选择(允许复制摘要文本) */
function hasActiveTextSelection(): boolean {
  const selection = window.getSelection();
  return selection !== null && selection.toString().length > 0;
}

export interface SessionLedgerProps {
  rows: LedgerRow[];
  selectedKey: string | null;
  /** 选区内 key 集合;null = 无选区,行不压暗 */
  focusKeys: ReadonlySet<string> | null;
  onSelect: (key: string) => void;
  onToggleTurn: (turn: number) => void;
  onToggleStep: (turn: number, step: number) => void;
  /** 目标 key 因折叠/过滤不可见时回调,页面负责展开 */
  onRevealKey?: (key: string) => void;
  className?: string;
}

export const SessionLedger = forwardRef<SessionLedgerHandle, SessionLedgerProps>(
  function SessionLedger(
    { rows, selectedKey, focusKeys, onSelect, onToggleTurn, onToggleStep, onRevealKey, className },
    ref,
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    // 贴底跟随:用户上翻历史时暂停自动滚动,滚回底部恢复(ref 避免每帧重渲染)
    const pinnedRef = useRef(true);

    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: (index) => rows[index]?.height ?? 30,
      overscan: 10,
    });

    useImperativeHandle(ref, () => ({
      scrollToKey(key) {
        const index = rows.findIndex((row) => row.record?.key === key);
        if (index < 0) {
          onRevealKey?.(key);
          return;
        }
        virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
      },
      scrollToFocus(keys) {
        let first = -1;
        let last = -1;
        for (let index = 0; index < rows.length; index += 1) {
          const record = rows[index]?.record;
          if (record && keys.has(record.key)) {
            if (first < 0) first = index;
            last = index;
          }
        }
        if (first < 0) return;
        const focusHeight = rows.slice(first, last + 1).reduce((sum, row) => sum + row.height, 0);
        const viewportHeight = scrollRef.current?.clientHeight ?? 0;
        virtualizer.scrollToIndex(first, {
          align: focusHeight > viewportHeight ? "start" : "center",
          behavior: "smooth",
        });
      },
      followTail() {
        if (!pinnedRef.current || rows.length === 0) return;
        virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
      },
      jumpToTail() {
        pinnedRef.current = true;
        if (rows.length === 0) return;
        virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
      },
    }));

    // rows 引用变化即可能追加了新行:贴底时跟随
    useEffect(() => {
      if (!pinnedRef.current || rows.length === 0) return;
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    }, [rows, virtualizer]);

    const paddingTop = virtualizer.getVirtualItems()[0]?.start ?? 0;
    const paddingBottom = virtualizer.getTotalSize() - (virtualizer.getVirtualItems().at(-1)?.end ?? 0);

    const handleRowActivate = (row: LedgerRow) => {
      if (hasActiveTextSelection()) return;
      if (row.collapsed) {
        if (row.collapsed.kind === "turn") onToggleTurn(row.collapsed.turn);
        else onToggleStep(row.collapsed.turn, row.collapsed.step);
        return;
      }
      if (row.record) onSelect(row.record.key);
    };

    const handleRowSecondary = (row: LedgerRow) => {
      // 双击内容行:折叠其所在 turn(再双击展开)
      if (!row.record) return;
      onToggleTurn(row.record.turn);
    };

    return (
      <div
        ref={scrollRef}
        className={cn("min-h-0 min-w-0 grow overflow-y-auto", className)}
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <table className="w-full table-fixed border-collapse text-[13px]" aria-rowcount={rows.length}>
          <colgroup>
            <col className="w-[7.5rem]" />
            <col />
            <col className="w-14" />
          </colgroup>
          <tbody>
            {paddingTop > 0 ? <tr style={{ height: paddingTop }} aria-hidden /> : null}
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const record = row.record;
              const outsideFocus = focusKeys !== null && !(record && focusKeys.has(record.key));
              const turnError = record?.isError === true;
              return (
                <tr
                  key={row.key}
                  data-row-key={row.key}
                  data-timeline-focus={outsideFocus ? "outside" : undefined}
                  aria-rowindex={item.index + 1}
                  style={{ height: row.height }}
                  className={cn(
                    "border-border/50 hover:bg-muted/60 cursor-pointer border-t transition-opacity select-none first:border-t-0",
                    record?.key === selectedKey && "bg-accent/60 hover:bg-accent/60",
                    outsideFocus && "opacity-35 hover:opacity-100",
                  )}
                  onClick={() => handleRowActivate(row)}
                  onDoubleClick={() => handleRowSecondary(row)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    handleRowActivate(row);
                  }}
                  tabIndex={0}
                >
                  <td className="relative p-0 align-middle">
                    {/* turn 竖轨:每行画一段,首行从顶、末行到底,±1px 与相邻行衔接 */}
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-0 bottom-0 left-[7px] w-0.5",
                        !row.turnStart && "-top-px",
                        !row.turnEnd && "-bottom-px",
                        turnError ? "bg-destructive/50" : "bg-foreground/15",
                        record?.key === selectedKey && "bg-foreground/50",
                      )}
                    />
                    {row.turnStart && record ? (
                      <span
                        className="text-muted-foreground absolute top-0 left-[10px] font-mono text-[9px] leading-none"
                        title={`Turn ${record.turn}`}
                      >
                        T{record.turn}
                      </span>
                    ) : null}
                    <div className="flex h-full items-center justify-end pr-2 pl-4">
                      {record ? <KindTag kind={record.kind} /> : null}
                    </div>
                  </td>
                  <td className="p-0 align-middle">
                    {record ? (
                      <p
                        className={cn(
                          "truncate pl-2 pr-3",
                          record.kind === "tool" && "font-mono text-xs",
                          record.isError && "text-destructive",
                        )}
                        title={record.summary}
                      >
                        {record.summary}
                      </p>
                    ) : row.collapsed ? (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground w-full truncate pl-2 pr-3 text-left text-[11px] underline-offset-2 hover:underline"
                      >
                        {row.collapsed.text}
                      </button>
                    ) : null}
                  </td>
                  <td className="p-0 pr-3 text-right align-middle">
                    <DurationCell row={row} />
                  </td>
                </tr>
              );
            })}
            {paddingBottom > 0 ? <tr style={{ height: paddingBottom }} aria-hidden /> : null}
          </tbody>
        </table>
      </div>
    );
  },
);
