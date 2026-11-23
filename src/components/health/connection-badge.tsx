import { CloudOff, Network } from "lucide-react";
import { Badge, StatusDot } from "@/components/ui/badge";
import { cn } from "@/lib/format";
import { CAPABILITY_META, LINK_STATE_META, type DataQualityFlag, type LinkState } from "./connection-state";
import type { CapabilityLevel } from "@/lib/vendors";

/** Connection badge for a recorder or a location. The description is the native tooltip. */
export function ConnectionBadge({ state, className, suffix }: { state: LinkState | "NONE"; className?: string; suffix?: React.ReactNode }) {
  if (state === "NONE") {
    return (
      <span title="No recorder registered for this location yet." className={className}>
        <Badge>No recorder</Badge>
      </span>
    );
  }
  const meta = LINK_STATE_META[state];
  return (
    <span title={meta.description} className={cn("inline-flex cursor-help", className)}>
      <Badge tone={meta.tone}>
        {state === "LIVE" ? <StatusDot status="ONLINE" pulse /> : null}
        {state === "OFFLINE" ? <StatusDot status="OFFLINE" /> : null}
        {state === "CHECKING" ? <StatusDot status="UNKNOWN" /> : null}
        {state === "PENDING" ? <Network className="h-3 w-3" /> : null}
        {state === "CLOUD" ? <CloudOff className="h-3 w-3" /> : null}
        {meta.label}
        {suffix}
      </Badge>
    </span>
  );
}

/** One capability (Live, Playback, …) for a vendor, toned by how proven it is. */
export function CapabilityChip({ name, level, note }: { name: string; level: CapabilityLevel | "blocked"; note?: string }) {
  const meta = CAPABILITY_META[level];
  const dot: Record<string, string> = {
    success: "bg-success",
    info: "bg-info",
    warning: "bg-warning",
    neutral: "bg-faint",
    danger: "bg-danger",
    accent: "bg-accent",
  };
  return (
    <span
      title={`${name}: ${meta.label}. ${note ?? meta.description}`}
      className={cn(
        "inline-flex cursor-help items-center gap-1.5 rounded-[3px] border px-1.5 py-px text-[11px] font-medium whitespace-nowrap",
        level === "blocked" || level === "unsupported" ? "border-dashed border-border-strong text-faint" : "border-border bg-surface text-text",
      )}
    >
      <span aria-hidden className={cn("inline-block h-1.5 w-1.5 rounded-full", dot[meta.tone])} />
      {name}
      <span className="sr-only"> {meta.label}</span>
    </span>
  );
}

export function DataQualityBadges({ flags, className }: { flags: DataQualityFlag[]; className?: string }) {
  if (flags.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap gap-1", className)}>
      {flags.map((f) => (
        <Badge key={f.key} tone={f.tone === "warning" ? "warning" : "neutral"}>
          {f.label}
        </Badge>
      ))}
    </span>
  );
}
