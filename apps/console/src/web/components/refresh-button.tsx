import { RefreshCw } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RefreshButtonProps = Omit<ComponentProps<typeof Button>, "children"> & {
  /** 查询请求进行中:图标旋转并禁用按钮 */
  isFetching: boolean;
  children: string;
};

export function RefreshButton({ isFetching, children, className, ...props }: RefreshButtonProps) {
  // 文案在刷新前后保持不变,避免按钮宽度跳动
  return (
    <Button size="sm" variant="outline" disabled={isFetching} className={className} {...props}>
      <RefreshCw className={cn(isFetching && "animate-spin")} />
      {children}
    </Button>
  );
}
