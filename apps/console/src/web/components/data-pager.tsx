import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DataPagerProps {
  /** 当前页码,从 1 开始 */
  page: number;
  hasNext: boolean;
  isFetching?: boolean;
  onPrev: () => void;
  onNext: () => void;
}

/** 游标分页器:只有上一页/下一页,没有跳页。首页且无下一页时不渲染。 */
export function DataPager({ page, hasNext, isFetching = false, onPrev, onNext }: DataPagerProps) {
  if (page === 1 && !hasNext) return null;

  return (
    <div className="flex items-center gap-2 pt-3">
      <span className="text-muted-foreground mr-auto text-sm tabular-nums">第 {page} 页</span>
      <Button size="sm" variant="outline" disabled={page === 1 || isFetching} onClick={onPrev}>
        <ChevronLeft /> 上一页
      </Button>
      <Button size="sm" variant="outline" disabled={!hasNext || isFetching} onClick={onNext}>
        下一页 <ChevronRight />
      </Button>
    </div>
  );
}
