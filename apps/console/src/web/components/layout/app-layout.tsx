import { useQuery } from "@tanstack/react-query";
import { Bot, CalendarClock, Menu, MessagesSquare, Settings } from "lucide-react";
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

const NAV_ITEMS = [
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/sessions", label: "Sessions", icon: MessagesSquare },
  { to: "/deployments", label: "Deployments", icon: CalendarClock },
  { to: "/settings", label: "Settings", icon: Settings },
];

function BrandMark() {
  return (
    <>
      <div className="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-md text-xs font-bold">
        n
      </div>
      <div className="text-sm font-semibold">nano console</div>
    </>
  );
}

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-1 flex-col gap-1 p-2">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            [
              "flex items-center gap-2 rounded-md px-3 py-2.5 text-sm md:py-2",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            ].join(" ")
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
  if (!data) return <Badge variant="outline" className="font-normal">local dev</Badge>;
  return (
    <Badge variant="secondary" className="max-w-48 truncate font-normal" title={data.email ?? data.name}>
      {data.name ?? data.email ?? "已登录"}
    </Badge>
  );
}

export function AppLayout() {
  const [navOpen, setNavOpen] = useState(false);
  return (
    <div className="bg-background flex min-h-svh flex-col md:flex-row">
      <aside className="bg-sidebar sticky top-3 m-3 hidden h-[calc(100svh-1.5rem)] w-56 shrink-0 flex-col rounded-xl border shadow-md md:flex">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <BrandMark />
        </div>
        <SidebarNav />
        <div className="border-t p-3">
          <IdentityTag />
        </div>
      </aside>

      <header className="bg-background sticky top-0 z-40 flex h-14 shrink-0 items-center gap-1 border-b px-2 md:hidden">
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10" aria-label="打开导航菜单">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="bg-sidebar w-72 gap-0 p-0">
            <SheetTitle className="flex h-14 shrink-0 items-center gap-2 border-b px-4 text-sm">
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
        <div className="mx-auto max-w-6xl p-4 md:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
