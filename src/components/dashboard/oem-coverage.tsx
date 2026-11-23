import Link from "next/link";
import { CapabilityChip } from "@/components/health/connection-badge";
import { CAPABILITY_META } from "@/components/health/connection-state";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/format";
import type { OemCoverageRow } from "@/server/queries/dashboard";

const LEGEND = ["verified", "supported", "unverified", "blocked"] as const;
const legendDot: Record<string, string> = { success: "bg-success", info: "bg-info", warning: "bg-warning", neutral: "bg-faint" };

/** Recorders per OEM, how many are reachable, and how proven each capability is for that make. */
export function OemCoverage({ rows }: { rows: OemCoverageRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.recorders));
  return (
    <Card className="h-full">
      <CardHeader
        title="Coverage by OEM"
        description="Registered recorders per make, how many the server can reach, and what is proven for each."
        action={
          <Link href="/devices" className="text-sm text-accent hover:underline">
            Recorders
          </Link>
        }
      />
      <CardBody className="space-y-1 px-3">
        {rows.map((r) => {
          const empty = r.recorders === 0;
          return (
            <div key={r.id} className={cn("grid grid-cols-1 items-center gap-x-4 gap-y-2 rounded-md px-2 py-2.5 transition-colors hover:bg-surface-2 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]", empty && "opacity-60")}>
              <div className="min-w-0">
                <p className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-semibold text-text" title={r.notes}>
                    {r.label}
                  </span>
                  <span className="truncate text-[11px] text-faint">{r.protocol}</span>
                </p>
                <p className="mt-0.5 text-[12px] text-muted">
                  {empty ? (
                    "No recorders registered"
                  ) : (
                    <>
                      {r.recorders} recorder{r.recorders === 1 ? "" : "s"}
                      {r.cameras ? ` · ${r.cameras} cameras` : ""}
                      {r.pending ? <span className="text-warning"> · {r.pending} pending</span> : null}
                      {r.cloud ? <span className="text-faint"> · {r.cloud} cloud-only</span> : null}
                    </>
                  )}
                </p>
              </div>

              <div className="min-w-0" title={`${r.connected} of ${r.recorders} reachable · ${r.live} live now`}>
                <div className="flex items-center gap-2">
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-[var(--chart-muted)]" style={{ width: `${(r.recorders / max) * 100}%` }} />
                    <div className="absolute inset-y-0 left-0 rounded-full bg-success transition-[width] duration-700" style={{ width: `${(r.live / max) * 100}%` }} />
                  </div>
                  <span className="w-14 shrink-0 text-right text-[12px] tabular-nums text-muted">
                    <span className={cn("font-semibold", r.live ? "text-success" : "text-text")}>{r.live}</span>/{r.recorders} live
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-1 sm:justify-end">
                {r.capabilities.map((c) => (
                  <CapabilityChip key={c.name} name={c.name} level={c.level} note={c.note} />
                ))}
              </div>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 pt-3 text-[11px] text-faint">
          {LEGEND.map((l) => (
            <span key={l} className="inline-flex items-center gap-1.5" title={CAPABILITY_META[l].description}>
              <span className={cn("inline-block h-1.5 w-1.5 rounded-full", legendDot[CAPABILITY_META[l].tone])} />
              {CAPABILITY_META[l].label}
            </span>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
