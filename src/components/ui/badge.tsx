import type { CameraStatus, Role } from "@/db/schema";
import { cn } from "@/lib/format";

type Tone = "neutral" | "success" | "danger" | "warning" | "info" | "accent";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  success: "bg-success-soft text-success border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  info: "bg-info-soft text-info border-transparent",
  accent: "bg-accent-soft text-accent border-transparent",
};

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-px text-[11px] font-bold uppercase tracking-[0.02em] whitespace-nowrap", tones[tone], className)}>
      {children}
    </span>
  );
}

export function StatusDot({ status, pulse = false, className }: { status: CameraStatus | "DISABLED"; pulse?: boolean; className?: string }) {
  const color =
    status === "ONLINE" ? "text-success bg-success" : status === "OFFLINE" ? "text-danger bg-danger" : status === "DISABLED" ? "text-faint bg-faint" : "text-warning bg-warning";
  return <span aria-hidden className={cn("inline-block h-2 w-2 rounded-full", color, pulse && status === "ONLINE" && "status-pulse", className)} />;
}

export function StatusBadge({ status, enabled = true }: { status: CameraStatus; enabled?: boolean }) {
  if (!enabled) {
    return (
      <Badge tone="neutral">
        <StatusDot status="DISABLED" /> Disabled
      </Badge>
    );
  }
  const tone: Tone = status === "ONLINE" ? "success" : status === "OFFLINE" ? "danger" : "warning";
  const label = status === "ONLINE" ? "Online" : status === "OFFLINE" ? "Offline" : "Unknown";
  return (
    <Badge tone={tone}>
      <StatusDot status={status} pulse={status === "ONLINE"} /> {label}
    </Badge>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  const tone: Tone = role === "ADMIN" ? "accent" : role === "MANAGER" ? "info" : "neutral";
  const label = role === "ADMIN" ? "Administrator" : role === "MANAGER" ? "Manager" : "Viewer";
  return <Badge tone={tone}>{label}</Badge>;
}
