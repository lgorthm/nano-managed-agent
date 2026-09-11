import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

/** 详情页返回链接:移动端显示在页首,桌面端显示在页尾 */
export function BackLink({ to, label, desktopOnly = false }: { to: string; label: string; desktopOnly?: boolean }) {
  return (
    <Link
      to={to}
      className={
        desktopOnly
          ? "text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
          : "text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors md:hidden"
      }
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </Link>
  );
}
