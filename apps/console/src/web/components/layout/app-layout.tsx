import { useQuery } from "@tanstack/react-query";
import { Bot, CalendarClock, Container, Menu, MessagesSquare, Puzzle, Settings } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { getIdentity } from "@/auth/identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/deployments", label: "Deployments", icon: CalendarClock },
  { to: "/environments", label: "Environments", icon: Container },
  { to: "/skills", label: "Skills", icon: Puzzle },
  { to: "/settings", label: "Settings", icon: Settings },
];

function BrandMark() {
  return (
    <>
      <div className="bg-primary text-primary-foreground grid size-7 shrink-0 place-items-center rounded-lg font-mono text-[13px] font-semibold">
        n
      </div>
      <div className="text-sm font-semibold tracking-tight">
        nano<span className="text-muted-foreground font-normal"> console</span>
      </div>
    </>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-1 flex-col gap-1 p-3">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2.5 rounded-lg border border-transparent px-3 py-2 text-sm transition-colors md:py-[7px]",
              isActive
                ? "bg-card text-foreground shadow-xs border-border/80 font-medium [&_svg]:text-pine-600"
                : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
            )
          }
        >
          <item.icon className="size-4" />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

function IdentityTag() {
  const { data } = useQuery({ queryKey: ["identity"], queryFn: getIdentity, staleTime: Infinity });
  if (!data) return <Badge variant="outline" className="font-normal text-muted-foreground">local dev</Badge>;
  return (
    <Badge
      variant="secondary"
      className="max-w-48 truncate font-normal"
      title={data.email ?? data.name}
    >
      {data.name ?? data.email ?? "已登录"}
    </Badge>
  );
}

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="bg-background flex min-h-svh flex-col md:flex-row">
      <aside className="bg-sidebar sticky top-3 m-3 hidden h-[calc(100svh-1.5rem)] w-56 shrink-0 flex-col rounded-xl border border-sidebar-border shadow-xs md:flex">
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
          <BrandMark />
        </div>
        <SidebarNav />
        <div className="border-t px-3 py-3">
          <IdentityTag />
        </div>
      </aside>

      <header className="bg-background/90 sticky top-0 z-40 flex h-14 shrink-0 items-center gap-1 border-b px-2 backdrop-blur md:hidden">
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10" aria-label="打开导航菜单">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="bg-sidebar w-72 gap-0 p-0">
            <SheetTitle className="flex h-14 shrink-0 items-center gap-2 px-4 text-sm">
              <BrandMark />
            </SheetTitle>
            <SheetDescription className="sr-only">主导航菜单</SheetDescription>
            <SidebarNav onNavigate={() => setNavOpen(false)} />
            <div className="shrink-0 border-t p-3">
              <IdentityTag />
            </div>
          </SheetContent>
        </Sheet>
        <div className="flex items-center gap-2 px-1">
          <BrandMark />
        </div>
      </header>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-[96rem] p-4 md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
