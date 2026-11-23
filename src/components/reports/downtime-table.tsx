import { Camera, HardDrive, History } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { DowntimePage } from "@/server/queries/downtime";
import { formatDurationShort, formatZoned } from "./format";
import { RunningDuration } from "./running-duration";

/** Downtime log: one row per offline period, newest first. */
export function DowntimeTable({
  page,
  timeZone,
  pageHref,
  historySince,
}: {
  page: DowntimePage;
  timeZone: string;
  pageHref: (p: number) => string;
  historySince: Date | null;
}) {
  const first = page.total === 0 ? 0 : (page.page - 1) * page.pageSize + 1;
  const last = Math.min(page.total, page.page * page.pageSize);

  return (
    <>
      {page.items.length === 0 ? (
        <EmptyState
          icon={<History className="h-5 w-5" />}
          title="No downtime in this range"
          description={
            historySince
              ? `Nothing matches these filters. Downtime history starts ${formatZoned(historySince, timeZone)}.`
              : "No camera or recorder has gone offline since downtime tracking started. Incidents appear here automatically after each health check."
          }
          className="m-4"
        />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Location</TH>
              <TH>Recorder</TH>
              <TH>Camera</TH>
              <TH className="text-right">Ch</TH>
              <TH>Went offline</TH>
              <TH>Came back</TH>
              <TH className="text-right">Duration</TH>
              <TH>Reason</TH>
              <TH>Alert</TH>
            </tr>
          </THead>
          <TBody>
            {page.items.map((r) => {
              const open = r.endedAt === null;
              const isDevice = r.entityType === "DEVICE";
              return (
                <TR key={r.id}>
                  <TD className="max-w-[180px]">
                    <p className="truncate text-[13px] font-medium text-text" title={r.storeName ?? ""}>
                      {r.storeName ?? <span className="text-faint">Unassigned</span>}
                    </p>
                    {r.storeCode ? <p className="font-mono text-[11px] text-faint">{r.storeCode}</p> : null}
                  </TD>
                  <TD className="max-w-[180px] text-[13px]">
                    <span className="inline-flex max-w-full items-center gap-1.5">
                      {isDevice ? <HardDrive className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="Recorder incident" /> : null}
                      <span className={isDevice ? "truncate font-medium text-text" : "truncate text-muted"} title={r.recorderName ?? ""}>
                        {r.recorderName ?? "—"}
                      </span>
                    </span>
                  </TD>
                  <TD className="max-w-[200px] text-[13px]">
                    {isDevice ? (
                      <span className="text-faint">Whole recorder</span>
                    ) : (
                      <span className="inline-flex max-w-full items-center gap-1.5">
                        <Camera className="h-3.5 w-3.5 shrink-0 text-faint" />
                        <span className="truncate font-medium text-text" title={r.entityName}>
                          {r.entityName}
                        </span>
                        {r.parentIncidentId ? (
                          <Badge tone="neutral" className="normal-case">
                            via recorder
                          </Badge>
                        ) : null}
                      </span>
                    )}
                  </TD>
                  <TD className="text-right font-mono text-[12px] text-muted tabular-nums">{r.channel ?? "—"}</TD>
                  <TD className="whitespace-nowrap text-[13px] text-muted tabular-nums">{formatZoned(r.startedAt, timeZone)}</TD>
                  <TD className="whitespace-nowrap text-[13px] tabular-nums">
                    {open ? <Badge tone="danger">Still offline</Badge> : <span className="text-muted">{formatZoned(r.endedAt, timeZone)}</span>}
                  </TD>
                  <TD className="whitespace-nowrap text-right text-[13px] font-medium tabular-nums">
                    {open ? <RunningDuration since={r.startedAt.toISOString()} className="text-danger" /> : formatDurationShort(r.durationSeconds)}
                  </TD>
                  <TD className="max-w-[240px]">
                    <p className="truncate text-[12px] text-muted" title={[r.startDetail, r.endDetail ? `Restored: ${r.endDetail}` : null].filter(Boolean).join("\n")}>
                      {r.startDetail || <span className="text-faint">—</span>}
                    </p>
                  </TD>
                  <TD className="whitespace-nowrap">
                    <AlertCell r={r} timeZone={timeZone} />
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-[13px] text-muted">
        <span className="tabular-nums">
          {page.total === 0 ? "0 incidents" : `${first.toLocaleString()}–${last.toLocaleString()} of ${page.total.toLocaleString()} incidents`} · page {page.page} of {page.pageCount}
        </span>
        <div className="flex gap-2">
          <Link
            aria-disabled={page.page <= 1}
            tabIndex={page.page <= 1 ? -1 : undefined}
            className={buttonClasses("secondary", "sm", page.page <= 1 ? "pointer-events-none opacity-50" : "")}
            href={pageHref(page.page - 1)}
            scroll={false}
          >
            Previous
          </Link>
          <Link
            aria-disabled={page.page >= page.pageCount}
            tabIndex={page.page >= page.pageCount ? -1 : undefined}
            className={buttonClasses("secondary", "sm", page.page >= page.pageCount ? "pointer-events-none opacity-50" : "")}
            href={pageHref(page.page + 1)}
            scroll={false}
          >
            Next
          </Link>
        </div>
      </div>
    </>
  );
}

function AlertCell({ r, timeZone }: { r: DowntimePage["items"][number]; timeZone: string }) {
  if (r.backfilled) {
    return (
      <span title="Already offline before alerting could see it: logged only, no email is sent for this outage">
        <Badge tone="neutral">Not emailed</Badge>
      </span>
    );
  }
  if (r.downAlertedAt) {
    const title = [`Offline alert: ${formatZoned(r.downAlertedAt, timeZone)}`, r.upAlertedAt ? `Restored alert: ${formatZoned(r.upAlertedAt, timeZone)}` : null].filter(Boolean).join("\n");
    return (
      <span title={title} className="inline-flex gap-1">
        <Badge tone="info">Sent</Badge>
        {r.upAlertedAt ? <Badge tone="success">Restored</Badge> : null}
      </span>
    );
  }
  if (r.endedAt === null) {
    return (
      <span title="Waiting for the offline grace period before alerting (or alerts are disabled)">
        <Badge tone="warning">Pending</Badge>
      </span>
    );
  }
  return (
    <span className="text-[12px] text-faint" title="Recovered within the grace period, or caused by its recorder being offline: no email sent">
      Not sent
    </span>
  );
}
