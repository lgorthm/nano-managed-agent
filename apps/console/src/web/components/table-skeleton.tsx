import { Skeleton } from "@/components/ui/skeleton";

/** 表格加载骨架:与真实表格同构(表头 + 行),避免加载完成时布局跳动 */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden className="rounded-lg border bg-card">
      <div className="border-b px-4 py-3.5">
        <Skeleton className="h-3 w-24" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-8 border-b px-4 py-4 last:border-b-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-36 max-w-full" />
            <Skeleton className="h-2.5 w-48 max-w-full" />
          </div>
          <Skeleton className="hidden h-3.5 w-28 md:block" />
          <Skeleton className="h-3.5 w-14" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}
