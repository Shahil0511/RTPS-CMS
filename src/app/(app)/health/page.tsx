import type { Metadata } from "next";
import { Camera, HardDrive } from "lucide-react";
import { HealthTable } from "@/components/health/health-table";
import { RecordersCard } from "@/components/health/recorders-card";
import { RunHealthButton } from "@/components/health/run-health-button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import type { CameraStatus } from "@/db/schema";
import { env } from "@/env";
import { can, rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { deviceUptimeFor, recentDeviceStatusEvents } from "@/lib/devices/health";
import { recentStatusEvents } from "@/lib/health/monitor";
import { listCamerasForUser } from "@/server/queries/cameras";
import { listDevicesForUser } from "@/server/queries/devices";
import { storeOptionsForUser } from "@/server/queries/stores";

export const metadata: Metadata = { title: "Health" };
export const dynamic = "force-dynamic";

interface HistoryEvent {
  key: string;
  kind: "camera" | "recorder";
  createdAt: Date;
  status: CameraStatus;
  name: string;
  store: string;
  detail: string | null;
}

export default async function HealthPage() {
  const user = await requireUser(rolesFor("health.view"));
  const [cameras, stores, devices] = await Promise.all([listCamerasForUser(user), storeOptionsForUser(user), listDevicesForUser(user)]);
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [cameraEvents, deviceEvents, deviceUptime] = await Promise.all([
    recentStatusEvents(30, cameras.map((c) => c.id)),
    recentDeviceStatusEvents(30, devices.map((d) => d.id)),
    deviceUptimeFor(
      devices.map((d) => d.id),
      since,
    ),
  ]);

  const events: HistoryEvent[] = [
    ...cameraEvents.map((e) => ({ key: `c${e.id}`, kind: "camera" as const, createdAt: e.createdAt, status: e.status, name: e.camera.name, store: e.camera.store.name, detail: e.detail })),
    ...deviceEvents.map((e) => ({ key: `d${e.id}`, kind: "recorder" as const, createdAt: e.createdAt, status: e.status, name: e.device.name, store: e.device.store.name, detail: e.detail })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 40);

  return (
    <>
      <PageHeader
        title="Health monitoring"
        description={`Online/offline connectivity checks every ${env.HEALTH_CHECK_INTERVAL_SECONDS}s: a TCP probe of each recorder plus stream state from the streaming server for every channel.`}
        actions={can(user, "health.run") ? <RunHealthButton /> : null}
      />

      <RecordersCard
        items={devices.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          store: d.store.name,
          host: d.host,
          rtspPort: d.rtspPort,
          status: d.status,
          isEnabled: d.isEnabled,
          lastLatencyMs: d.lastLatencyMs,
          lastCheckedAt: d.lastCheckedAt,
          lastError: d.lastError,
          uptime24h: deviceUptime.get(d.id) ?? null,
          cameraCount: d.cameraCount,
          onlineCameraCount: d.onlineCameraCount,
          storageStatus: d.storageStatus,
        }))}
      />

      <HealthTable stores={stores.map((s) => ({ id: s.id, name: s.name }))} refreshSeconds={Math.max(10, Math.min(60, env.HEALTH_CHECK_INTERVAL_SECONDS))} />

      <Card className="mt-5">
        <CardHeader title="Status history" description="Most recent transitions across your recorders and cameras." />
        <CardBody className="px-0 pb-0">
          {events.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted">No transitions recorded yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {events.map((e) => (
                <li key={e.key} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <StatusDot status={e.status} />
                  <span className="w-44 shrink-0 text-[13px] text-muted">{formatDateTime(e.createdAt, { timeStyle: "medium" })}</span>
                  <span className="text-faint" title={e.kind === "recorder" ? "Recorder" : "Camera"}>
                    {e.kind === "recorder" ? <HardDrive className="h-3.5 w-3.5" /> : <Camera className="h-3.5 w-3.5" />}
                  </span>
                  <span className="font-medium text-text">{e.name}</span>
                  <span className="text-faint">{e.store}</span>
                  <span className={`ml-auto text-[12px] ${e.status === "ONLINE" ? "text-success" : e.status === "OFFLINE" ? "text-danger" : "text-warning"}`}>
                    {e.status === "ONLINE" ? "online" : e.status === "OFFLINE" ? "offline" : "unknown"}
                  </span>
                  {e.detail ? <span className="hidden max-w-sm truncate text-[12px] text-faint lg:inline" title={e.detail}>{e.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
