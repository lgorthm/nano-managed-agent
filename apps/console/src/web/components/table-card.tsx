import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

type TableCardProps = ComponentProps<'div'>;

/**
 * 列表页表格卡片:限高为视窗内剩余空间,表格在卡片内部滚动,
 * 避免长表格把页头(刷新/新建按钮)滚出视窗。
 *
 * 滚动容器必须是 Table 自带的 [data-slot=table-container]:
 * 它已有 overflow-x-auto,会成为 sticky 表头的定位容器,
 * 在外层再包一层滚动 div 会让表头吸顶失效。
 */
export function TableCard({ className, children, ...props }: TableCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card',
        // 移动端额外扣除顶部固定应用头(h-14)与更矮的页头;md 起无应用头
        // rounded-[inherit] 让滚动容器按卡片圆角裁剪,否则表头的 bg-card 会在上角溢出圆角弧线
        '[&>[data-slot=table-container]]:rounded-[inherit] [&>[data-slot=table-container]]:max-h-[calc(100svh-18rem)] md:[&>[data-slot=table-container]]:max-h-[calc(100svh-14rem)] [&>[data-slot=table-container]]:overflow-y-auto',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
