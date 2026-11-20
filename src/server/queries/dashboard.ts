import "server-only";
import { desc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { deviceStatusEvents, type CameraStatus, type DeviceKind, type SiteKind } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/session";
import { availability, type AvailabilityPoint } from "@/lib/health/availability";
import { recentStatusEvents } from "@/lib/health/monitor";
import { mtx } from "@/lib/mediamtx/client";
import { activeUsersSince, loginFailuresSince, recentAuditLogs } from "./audit";
import { listCamerasForUser } from "./cameras";
import { listDevicesForUser } from "./devices";
import { storeOptionsForUser } from "./stores";

export interface DashboardRecorder {
  id: string;
  name: string;
  kind: DeviceKind;
  site: string;
  host: string;
  status: CameraStatus;
  isEnabled: boolean;
  model: string | null;
  cameraCount: number;
  onlineCameraCount: number;
  storageStatus: string | null;
  storageHealthy: boolean | null;
  clockDriftSeconds: number | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  uptime24h: number | null;
}

export interface DashboardSite {
  id: string;
  name: string;
  code: string;
  kind: SiteKind;
  online: number;
  offline: number;
  unknown: number;
  total: number;
}

export interface DashboardEvent {
  id: string;
  kind: "camera" | "recorder";
  targetId: string;
  name: string;
  site: string;
  status: CameraStatus;
  detail: string | null;
  at: string;
}

export interface DashboardData {
  cameras: { total: number; enabled: number; online: number; offline: number; unknown: number; disabled: number };
  recorders: { total: number; online: number; offline: number; nvr: number; dvr: number; diskIssues: number; clockIssues: number };
  availability: { cameras24h: number | null; recorders24h: number | null; cameraSeries: AvailabilityPoint[]; recorderSeries: AvailabilityPoint[] };
  sites: DashboardSite[];
  recorderList: DashboardRecorder[];
  offlineCameras: Array<{ id: string; name: string; site: string; recorder: string | null; detail: string | null; since: string | null }>;
  events: DashboardEvent[];
  recentAudit: Awaited<ReturnType<typeof recentAuditLogs>>;
  security: { loginFailures24h: number; activeUsers24h: number };
  streaming: { reachable: boolean; version: string | null; error?: string };
}

const HOUR = 3600_000;
/** A recorder clock this far off is flagged on the dashboard (it is corrected for playback either way). */
export const CLOCK_WARN_SECONDS = 120;

export async function loadDashboard(user: SessionUser): Promise<DashboardData> {
  const now = new Date();
  const since = new Date(Math.floor((now.getTime() - 24 * HOUR) / HOUR) * HOUR + HOUR);
  const since24h = new Date(now.getTime() - 24 * HOUR);

  const [cams, devs, sites, streaming] = await Promise.all([
    listCamerasForUser(user),
    listDevicesForUser(user),
    storeOptionsForUser(user),
    mtx
      .info()
      .then((i) => ({ reachable: true, version: i.version ?? null }))
      .catch((e: Error) => ({ reachable: false, version: null, error: e.message })),
  ]);

  const enabledCams = cams.filter((c) => c.isEnabled);
  const camIds = enabledCams.map((c) => c.id);
  const devIds = devs.map((d) => d.id);

  const [camAvail, devAvail, camEvents, devEvents, recentAudit, loginFailures24h, activeUsers24h] = await Promise.all([
    availability("camera", camIds, since, now, HOUR),
    availability("device", devIds, since, now, HOUR),
    camIds.length ? recentStatusEvents(12, camIds) : Promise.resolve([]),
    devIds.length
      ? db.query.deviceStatusEvents.findMany({
          where: inArray(deviceStatusEvents.deviceId, devIds),
          orderBy: desc(deviceStatusEvents.createdAt),
          limit: 12,
          with: { device: { with: { store: true } } },
        })
      : Promise.resolve([]),
    user.isAdmin ? recentAuditLogs(8) : Promise.resolve([]),
    user.isAdmin ? loginFailuresSince(since24h) : Promise.resolve(0),
    user.isAdmin ? activeUsersSince(since24h) : Promise.resolve(0),
  ]);

  const siteMap = new Map<string, DashboardSite>(sites.map((s) => [s.id, { id: s.id, name: s.name, code: s.code, kind: s.kind, online: 0, offline: 0, unknown: 0, total: 0 }]));
  for (const c of enabledCams) {
    const s = siteMap.get(c.storeId);
    if (!s) continue;
    s.total += 1;
    if (c.status === "ONLINE") s.online += 1;
    else if (c.status === "OFFLINE") s.offline += 1;
    else s.unknown += 1;
  }

  const recorderList: DashboardRecorder[] = devs.map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    site: d.store.name,
    host: d.host,
    status: d.status,
    isEnabled: d.isEnabled,
    model: d.model,
    cameraCount: d.cameraCount,
    onlineCameraCount: d.onlineCameraCount,
    storageStatus: d.storageStatus,
    storageHealthy: d.storageStatus == null ? null : /\bOK\b/.test(d.storageStatus) && !/error|abnormal|unformat/i.test(d.storageStatus),
    clockDriftSeconds: d.clockDriftSeconds,
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    lastError: d.lastError,
    uptime24h: devAvail.perEntity.get(d.id) ?? null,
  }));

  const events: DashboardEvent[] = [
    ...camEvents.map((e) => ({ id: `c${e.id}`, kind: "camera" as const, targetId: e.cameraId, name: e.camera.name, site: e.camera.store.name, status: e.status, detail: e.detail, at: e.createdAt.toISOString() })),
    ...devEvents.map((e) => ({ id: `d${e.id}`, kind: "recorder" as const, targetId: e.deviceId, name: e.device.name, site: e.device.store.name, status: e.status, detail: e.detail, at: e.createdAt.toISOString() })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 12);

  const recordersEnabled = devs.filter((d) => d.isEnabled);
  return {
    cameras: {
      total: cams.length,
      enabled: enabledCams.length,
      online: enabledCams.filter((c) => c.status === "ONLINE").length,
      offline: enabledCams.filter((c) => c.status === "OFFLINE").length,
      unknown: enabledCams.filter((c) => c.status === "UNKNOWN").length,
      disabled: cams.length - enabledCams.length,
    },
    recorders: {
      total: recordersEnabled.length,
      online: recordersEnabled.filter((d) => d.status === "ONLINE").length,
      offline: recordersEnabled.filter((d) => d.status === "OFFLINE").length,
      nvr: recordersEnabled.filter((d) => d.kind === "NVR").length,
      dvr: recordersEnabled.filter((d) => d.kind === "DVR").length,
      diskIssues: recorderList.filter((r) => r.isEnabled && r.storageHealthy === false).length,
      clockIssues: recorderList.filter((r) => r.isEnabled && Math.abs(r.clockDriftSeconds ?? 0) >= CLOCK_WARN_SECONDS).length,
    },
    availability: { cameras24h: camAvail.overall, recorders24h: devAvail.overall, cameraSeries: camAvail.series, recorderSeries: devAvail.series },
    sites: [...siteMap.values()].sort((a, b) => b.offline - a.offline || b.total - a.total || a.name.localeCompare(b.name)),
    recorderList,
    offlineCameras: enabledCams
      .filter((c) => c.status === "OFFLINE")
      .slice(0, 50)
      .map((c) => ({ id: c.id, name: c.name, site: c.store.name, recorder: c.device?.name ?? null, detail: c.lastError, since: c.lastOnlineAt?.toISOString() ?? null })),
    events,
    recentAudit,
    security: { loginFailures24h, activeUsers24h },
    streaming,
  };
}
