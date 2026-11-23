import { Activity, Camera, CheckCircle2, HardDrive } from "lucide-react";
import Link from "next/link";
import { incidentHref } from "@/components/dashboard/incident-list";
import { LiveDuration } from "@/components/dashboard/live-duration";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { IncidentItem } from "@/server/queries/dashboard";

/** Ongoing outages from the downtime log (recorders first), with a running duration and a link to the reports. */
export function OpenIncidentsCard({ items, total, available, reportsHref }: { items: IncidentItem[]; total: number; available: boolean; reportsHref: string | null }) {
  return (
    <Card className="mb-5 overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted" /> Open incidents
            {available && total ? <Badge tone="danger">{total}</Badge> : null}
          </span>
        }
        description="Outages still in progress on connected recorders and cameras. Closed incidents and alert history are in the downtime reports."
        action={
          reportsHref ? (
            <Link href={reportsHref} className="text-sm text-accent hover:underline">
              Downtime reports
            </Link>
          ) : null
        }
      />
      {!available ? (
        <CardBody>
          <p className="text-sm text-muted">The downtime log is not available yet (database migration pending).</p>
        </CardBody>
      ) : items.length === 0 ? (
        <CardBody>
          <p className="flex items-center gap-2 text-sm text-muted">
            <CheckCircle2 className="h-4 w-4 text-success" /> Nothing is down right now.
          </p>
        </CardBody>
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <TH>What</TH>
                <TH>Location</TH>
                <TH>Offline since</TH>
                <TH>Duration</TH>
                <TH>Reason</TH>
              </tr>
            </THead>
            <TBody>
              {items.map((i) => {
                const href = incidentHref(i);
                return (
                  <TR key={i.id}>
                    <TD>
                      <span className="inline-flex items-center gap-2">
                        {i.entityType === "DEVICE" ? <HardDrive className="h-3.5 w-3.5 text-danger" /> : <Camera className="h-3.5 w-3.5 text-danger" />}
                        {href ? (
                          <Link href={href} className="font-medium text-text hover:text-accent">
                            {i.entityName}
                          </Link>
                        ) : (
                          <span className="font-medium text-text">{i.entityName}</span>
                        )}
                      </span>
                      <p className="text-[11px] text-faint">
                        {i.entityType === "DEVICE" ? "Recorder" : "Camera"}
                        {i.causedByRecorder ? " · its recorder is down" : ""}
                      </p>
                    </TD>
                    <TD className="text-[13px]">{i.storeName ?? "—"}</TD>
                    <TD className="text-[13px] text-muted" title={formatDateTime(i.startedAt)}>
                      {formatDateTime(i.startedAt)}
                      <p className="text-[11px] text-faint">{formatRelative(i.startedAt)}</p>
                    </TD>
                    <TD className="text-[13px] font-semibold tabular-nums text-danger">
                      <LiveDuration since={i.startedAt} />
                    </TD>
                    <TD className="max-w-[320px] truncate text-[12px] text-faint" title={i.detail ?? ""}>
                      {i.detail ?? ""}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          {total > items.length ? (
            <p className="border-t border-border px-5 py-2.5 text-[12px] text-muted">
              Showing {items.length} of {total} open incidents.{" "}
              {reportsHref ? (
                <Link href={reportsHref} className="text-accent hover:underline">
                  See all in the downtime reports
                </Link>
              ) : null}
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
