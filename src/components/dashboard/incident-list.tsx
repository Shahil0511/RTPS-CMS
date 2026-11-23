import { Camera, CheckCircle2, HardDrive } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn, formatDateTime, formatDuration, formatRelative } from "@/lib/format";
import type { IncidentItem } from "@/server/queries/dashboard";
import { LiveDuration } from "./live-duration";

export function incidentHref(i: Pick<IncidentItem, "entityType" | "cameraId" | "deviceId">): string | null {
  if (i.entityType === "CAMERA" && i.cameraId) return `/live/${i.cameraId}`;
  if (i.entityType === "DEVICE" && i.deviceId) return `/cameras?device=${i.deviceId}`;
  return null;
}

/** Compact incident feed. Open incidents are highlighted and show a running duration. */
export function IncidentList({ items }: { items: IncidentItem[] }) {
  return (
    <ul className="space-y-1">
      {items.map((i) => {
        const open = i.endedAt == null;
        const href = incidentHref(i);
        return (
          <li
            key={i.id}
            className={cn(
              "group flex items-start gap-3 rounded-md border px-3 py-2 transition-colors fade-in",
              open ? "border-danger/25 bg-danger-soft/60" : "border-transparent hover:bg-surface-2",
            )}
          >
            <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full", open ? "bg-danger-soft text-danger" : "bg-surface-2 text-faint")}>
              {i.entityType === "DEVICE" ? <HardDrive className="h-3.5 w-3.5" /> : <Camera className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px]">
                {href ? (
                  <Link href={href} className="font-medium text-text hover:text-accent">
                    {i.entityName}
                  </Link>
                ) : (
                  <span className="font-medium text-text">{i.entityName}</span>
                )}
                {i.storeName ? <span className="text-muted"> · {i.storeName}</span> : null}
              </p>
              <p className="truncate text-[11px] text-faint" title={i.detail ?? formatDateTime(i.startedAt)}>
                {i.entityType === "DEVICE" ? "Recorder" : "Camera"} went offline {formatRelative(i.startedAt)}
                <span className="hidden sm:inline"> · {formatDateTime(i.startedAt)}</span>
                {i.causedByRecorder ? " · recorder down" : ""}
              </p>
            </div>
            <div className="shrink-0 text-right">
              {open ? (
                <>
                  <Badge tone="danger">
                    <span className="status-pulse inline-block h-1.5 w-1.5 rounded-full bg-danger text-danger" /> Ongoing
                  </Badge>
                  <p className="mt-1 text-[12px] font-semibold tabular-nums text-danger">
                    <LiveDuration since={i.startedAt} />
                  </p>
                </>
              ) : (
                <>
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Resolved
                  </span>
                  <p className="mt-1 text-[12px] tabular-nums text-muted">{formatDuration(i.durationSeconds ?? (new Date(i.endedAt ?? i.startedAt).getTime() - new Date(i.startedAt).getTime()) / 1000)}</p>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
