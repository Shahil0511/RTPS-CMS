import { Camera, CheckCircle2, HardDrive } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import type { DowntimeRow } from "@/server/queries/downtime";
import { formatZoned } from "./format";
import { RunningDuration } from "./running-duration";

/** Everything that is offline right now (open incidents), oldest first, with a live counter. */
export function OfflineNowCard({ items, total, timeZone }: { items: DowntimeRow[]; total: number; timeZone: string }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            Currently offline
            <Badge tone={total > 0 ? "danger" : "success"}>{total}</Badge>
          </span>
        }
        description="Open incidents right now, whatever the date range."
      />
      {items.length === 0 ? (
        <div className="flex items-center gap-2 px-5 pb-5 text-[13px] text-muted">
          <CheckCircle2 className="h-4 w-4 text-success" /> Every monitored camera and recorder is online.
        </div>
      ) : (
        <ul className="max-h-[420px] divide-y divide-border overflow-y-auto border-t border-border">
          {items.map((r) => {
            const isDevice = r.entityType === "DEVICE";
            const Icon = isDevice ? HardDrive : Camera;
            return (
              <li key={r.id} className="flex items-start gap-3 px-5 py-2.5 transition-colors hover:bg-surface-hover">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-danger-soft text-danger">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-text" title={r.entityName}>
                    {r.entityName}
                    {!isDevice && r.channel != null ? <span className="ml-1 font-mono text-[11px] text-faint">ch {r.channel}</span> : null}
                  </p>
                  <p className="truncate text-[12px] text-muted" title={[r.storeName, r.recorderName].filter(Boolean).join(" · ")}>
                    {r.storeName ?? "Unassigned"}
                    {!isDevice && r.recorderName ? ` · ${r.recorderName}` : isDevice ? " · recorder" : ""}
                  </p>
                  <p className="text-[11px] text-faint">since {formatZoned(r.startedAt, timeZone)}</p>
                </div>
                <RunningDuration since={r.startedAt.toISOString()} className="shrink-0 text-[13px] font-semibold text-danger tabular-nums" />
              </li>
            );
          })}
        </ul>
      )}
      {total > items.length ? (
        <p className="border-t border-border px-5 py-2 text-[12px] text-faint">
          Showing the {items.length} longest-running of {total}. Filter by location or use “Still offline” for the full list.
        </p>
      ) : null}
    </Card>
  );
}
