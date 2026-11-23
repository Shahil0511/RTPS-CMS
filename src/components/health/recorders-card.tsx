import { ChevronDown, Cloud, HardDrive, Network } from "lucide-react";
import Link from "next/link";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { CameraStatus, DeviceKind } from "@/db/schema";
import { cn, formatRelative } from "@/lib/format";
import { ConnectionBadge, DataQualityBadges } from "./connection-badge";
import type { DataQualityFlag, LinkState } from "./connection-state";

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
  vendorLabel: string;
  linkState: LinkState;
}

/** Connected (DIRECT/RELAY) recorders: the only ones that are probed, charted and alerted on. */
export function RecordersCard({ items }: { items: RecorderHealthItem[] }) {
  const enabled = items.filter((i) => i.isEnabled);
  const online = enabled.filter((i) => i.status === "ONLINE").length;
  const offline = enabled.filter((i) => i.status === "OFFLINE").length;

  return (
    <Card className="mb-5 overflow-hidden">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted" /> Connected recorders
          </span>
        }
        description="Recorders the server can reach (TCP probe of the RTSP port). An offline recorder takes all of its channels down and raises an alert."
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
        <EmptyState
          icon={<HardDrive className="h-5 w-5" />}
          title="No connected recorders"
          description="Add an NVR or DVR with a reachable address under Manage → Recorders, or give a pending recorder a network route."
          className="m-4"
        />
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
                    {d.kind} · {d.vendorLabel} · {d.store} · <span className="font-mono">{d.host}:{d.rtspPort}</span>
                  </p>
                </TD>
                <TD>{d.linkState === "CHECKING" ? <ConnectionBadge state="CHECKING" /> : <StatusBadge status={d.status} enabled={d.isEnabled} />}</TD>
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

export interface AwaitingRecorderItem {
  id: string;
  name: string;
  kind: DeviceKind;
  store: string;
  storeId: string;
  host: string;
  vendorLabel: string;
  linkState: LinkState;
  cloudPlatform: string | null;
  flags: DataQualityFlag[];
}

/**
 * Recorders that are registered but have no network path (pending network / cloud-only / disabled).
 * Shown apart from the connected ones so 60+ unreachable store recorders do not read as outages.
 */
export function AwaitingConnectivityCard({ items }: { items: AwaitingRecorderItem[] }) {
  if (items.length === 0) return null;
  const pending = items.filter((i) => i.linkState === "PENDING").length;
  const cloud = items.filter((i) => i.linkState === "CLOUD").length;
  const disabled = items.filter((i) => i.linkState === "DISABLED").length;
  const sites = new Set(items.map((i) => i.storeId)).size;

  return (
    <Card id="awaiting" className="mb-5 scroll-mt-20 overflow-hidden">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 pt-4 pb-3 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <h3 className="inline-flex items-center gap-2 text-[15px] font-semibold leading-6 text-text">
              <Network className="h-4 w-4 text-muted" /> Awaiting connectivity
            </h3>
            <p className="mt-0.5 text-[13px] text-muted">
              {items.length} recorder{items.length === 1 ? "" : "s"} at {sites} location{sites === 1 ? "" : "s"} are registered but have no network path from the server. They are not
              monitored and never raise alerts, so they are not outages.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2 text-[12px]">
            {pending ? <Badge tone="warning">{pending} pending network</Badge> : null}
            {cloud ? <Badge>{cloud} cloud-only</Badge> : null}
            {disabled ? <Badge>{disabled} disabled</Badge> : null}
            <ChevronDown className="h-4 w-4 text-faint transition-transform duration-200 group-open:rotate-180" />
          </div>
        </summary>
        <Table>
          <THead>
            <tr>
              <TH>Recorder</TH>
              <TH>Location</TH>
              <TH>Connection</TH>
              <TH>Address</TH>
              <TH>Data quality</TH>
            </tr>
          </THead>
          <TBody>
            {items.map((d) => (
              <TR key={d.id}>
                <TD>
                  <span className="font-medium text-text">{d.name}</span>
                  <p className="text-[12px] text-faint">
                    {d.kind} · {d.vendorLabel}
                  </p>
                </TD>
                <TD className="text-[13px]">
                  <Link href={`/devices?store=${d.storeId}`} className="text-text hover:text-accent">
                    {d.store}
                  </Link>
                </TD>
                <TD>
                  <ConnectionBadge state={d.linkState} />
                  {d.cloudPlatform ? (
                    <p className="mt-1 inline-flex items-center gap-1 text-[11px] text-faint">
                      <Cloud className="h-3 w-3" /> {d.cloudPlatform}
                    </p>
                  ) : null}
                </TD>
                <TD className="font-mono text-[12px] text-muted">{d.host || <span className="font-sans text-faint">No address</span>}</TD>
                <TD>{d.flags.length ? <DataQualityBadges flags={d.flags} /> : <span className="text-[12px] text-faint">—</span>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </details>
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
