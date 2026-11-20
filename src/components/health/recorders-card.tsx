import { HardDrive } from "lucide-react";
import Link from "next/link";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { CameraStatus, DeviceKind } from "@/db/schema";
import { cn, formatRelative } from "@/lib/format";

export interface RecorderHealthItem {
  id: string;
  name: string;
  kind: DeviceKind;
  store: string;
  host: string;
  rtspPort: number;
  status: CameraStatus;
  isEnabled: boolean;
  lastLatencyMs: number | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
  uptime24h: number | null;
  cameraCount: number;
  onlineCameraCount: number;
  storageStatus: string | null;
}

/** Server-rendered recorder summary shown above the camera health table. */
export function RecordersCard({ items }: { items: RecorderHealthItem[] }) {
  const enabled = items.filter((i) => i.isEnabled);
  const online = enabled.filter((i) => i.status === "ONLINE").length;
  const offline = enabled.filter((i) => i.status === "OFFLINE").length;

  return (
    <Card className="mb-5 overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted" /> Recorders
          </span>
        }
        description="NVR/DVR reachability (TCP probe of the RTSP port). An offline recorder takes all of its channels down."
        action={
          items.length ? (
            <div className="flex gap-2 text-[12px]">
              <Badge tone="success">{online} online</Badge>
              <Badge tone={offline ? "danger" : "neutral"}>{offline} offline</Badge>
            </div>
          ) : null
        }
      />
      {items.length === 0 ? (
        <EmptyState icon={<HardDrive className="h-5 w-5" />} title="No recorders" description="Add an NVR or DVR under Manage → Recorders to monitor it here." className="m-4" />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Recorder</TH>
              <TH>Status</TH>
              <TH>Uptime 24h</TH>
              <TH>Latency</TH>
              <TH>Channels</TH>
              <TH>Last check</TH>
              <TH>Detail</TH>
            </tr>
          </THead>
          <TBody>
            {items.map((d) => (
              <TR key={d.id} className={!d.isEnabled ? "opacity-60" : ""}>
                <TD>
                  <Link href={`/cameras?device=${d.id}`} className="font-medium text-text hover:text-accent">
                    {d.name}
                  </Link>
                  <p className="text-[12px] text-faint">
                    {d.kind} · {d.store} · <span className="font-mono">{d.host}:{d.rtspPort}</span>
                  </p>
                </TD>
                <TD>
                  <StatusBadge status={d.status} enabled={d.isEnabled} />
                </TD>
                <TD>
                  <UptimeBar value={d.uptime24h} />
                </TD>
                <TD className="tabular-nums text-[13px]">{d.lastLatencyMs != null ? `${d.lastLatencyMs} ms` : "—"}</TD>
                <TD className="tabular-nums text-[13px]">
                  <span className={cn("font-medium", d.cameraCount > 0 && d.onlineCameraCount < d.cameraCount ? "text-warning" : "text-success")}>{d.onlineCameraCount}</span>
                  <span className="text-faint"> / {d.cameraCount} online</span>
                  {d.storageStatus ? <p className="text-[11px] text-faint">{d.storageStatus}</p> : null}
                </TD>
                <TD className="text-[13px] text-muted">{formatRelative(d.lastCheckedAt)}</TD>
                <TD className="max-w-[320px] truncate text-[12px] text-faint" title={d.lastError ?? ""}>
                  {d.lastError ?? ""}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function UptimeBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[12px] text-faint">no data</span>;
  const tone = value >= 99 ? "bg-success" : value >= 90 ? "bg-warning" : "bg-danger";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[12px] tabular-nums">{value}%</span>
    </div>
  );
}
