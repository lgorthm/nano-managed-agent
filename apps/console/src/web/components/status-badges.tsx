import { cn } from "@/lib/utils";
import type { DeploymentStatus, SessionStatus } from "@nano/shared/glm";
import { Badge } from "@/components/ui/badge";

const SESSION_STATUS_CLASS: Record<SessionStatus, string> = {
  idle: "bg-slate-100 text-slate-700",
  running: "bg-emerald-100 text-emerald-700",
  rescheduling: "bg-amber-100 text-amber-700",
  terminated: "bg-zinc-200 text-zinc-600",
};

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return <Badge variant="secondary" className={cn("font-normal", SESSION_STATUS_CLASS[status])}>{status}</Badge>;
}

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "font-normal",
        status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700",
      )}
    >
      {status}
    </Badge>
  );
}
