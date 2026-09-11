import type { DeploymentStatus, EnvironmentState, SessionStatus } from "@nano/shared/glm";
import { cn } from "@/lib/utils";

/**
 * 状态徽章:圆点 + 语义 tint(tint-* 类统一在 index.css 定义,亮暗主题各自适配)。
 * 不走 Badge 的 variant,避免 cva 底色和 tint 类互相覆盖。
 */
export function StatusBadge({
  tint,
  className,
  children,
}: {
  tint: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tint,
        className,
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current opacity-60" />
      {children}
    </span>
  );
}

const SESSION_STATUS_TINT: Record<SessionStatus, string> = {
  idle: "tint-neutral",
  running: "tint-positive",
  rescheduling: "tint-warning",
  terminated: "tint-neutral",
};

export function SessionStatusBadge({ status, className }: { status: SessionStatus; className?: string }) {
  return (
    <StatusBadge tint={SESSION_STATUS_TINT[status]} className={className}>
      {status}
    </StatusBadge>
  );
}

export function DeploymentStatusBadge({ status, className }: { status: DeploymentStatus; className?: string }) {
  return (
    <StatusBadge
      tint={status === "active" ? "tint-positive" : "tint-warning"}
      className={className}
    >
      {status}
    </StatusBadge>
  );
}

export function EnvironmentStateBadge({ state, className }: { state: EnvironmentState; className?: string }) {
  return (
    <StatusBadge tint={state === "active" ? "tint-positive" : "tint-neutral"} className={className}>
      {state}
    </StatusBadge>
  );
}
