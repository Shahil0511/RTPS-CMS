import { Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import type { UnstableCamera } from "@/server/queries/downtime";
import { formatDurationShort, formatZoned } from "./format";

/** Top cameras by number of offline incidents in the range (recorder-caused outages excluded). */
export function UnstableCamerasCard({ items, timeZone }: { items: UnstableCamera[]; timeZone: string }) {
  const max = items.reduce((m, c) => Math.max(m, c.incidents), 0);
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Most unstable cameras" description="Top 10 by incidents in this range. Outages caused by the recorder are not counted." />
      {items.length === 0 ? (
        <div className="flex items-center gap-2 px-5 pb-5 text-[13px] text-muted">
          <Activity className="h-4 w-4 text-success" /> No camera dropped out on its own in this range.
        </div>
      ) : (
        <ol className="divide-y divide-border border-t border-border">
          {items.map((c, i) => (
            <li key={c.cameraId} className="px-5 py-2.5 transition-colors hover:bg-surface-hover" title={`Last went offline ${formatZoned(c.lastStartedAt, timeZone)}`}>
              <div className="flex items-center gap-3">
                <span className="w-4 shrink-0 text-right text-[12px] font-semibold text-faint tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-[13px] font-medium text-text">
                    <span className="truncate">{c.name}</span>
                    {c.openNow ? <Badge tone="danger">Offline</Badge> : null}
                  </p>
                  <p className="truncate text-[12px] text-muted">{c.storeName ?? "Unassigned"}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[13px] font-semibold tabular-nums text-text">
                    {c.incidents}
                    <span className="ml-0.5 text-[11px] font-normal text-faint">×</span>
                  </p>
                  <p className="text-[11px] text-faint tabular-nums">{formatDurationShort(c.downtimeSeconds)}</p>
                </div>
              </div>
              <div className="ml-7 mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                <span className="block h-full rounded-full bg-warning transition-[width] duration-700" style={{ width: `${max > 0 ? Math.max(4, (c.incidents / max) * 100) : 0}%` }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
