import "server-only";
import { and, count, countDistinct, desc, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { alertRecipients, deviceStatusEvents, downtimeIncidents, users, userStores, type CameraStatus, type DeviceKind, type DowntimeEntityType, type SiteKind } from "@/db/schema";
import { deviceVendorId, oemGroupOf, OEM_GROUPS, recorderLinkState, capabilityUsable, type LinkState, type OemGroup } from "@/components/health/connection-state";
import { getMailerStatus } from "@/lib/alerts/mailer";
import { getAlertSettings } from "@/lib/alerts/settings";
import { can, ROLE_LABELS, rolesFor, storeScope } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";
import { availability, type AvailabilityPoint } from "@/lib/health/availability";
import { recentStatusEvents } from "@/lib/health/monitor";
import { mtx } from "@/lib/mediamtx/client";
import { isConnectable, VENDORS, type CapabilityLevel } from "@/lib/vendors";
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
  linkState: LinkState;
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
  recorders: { total: number; connected: number; online: number; offline: number; nvr: number; dvr: number; diskIssues: number; clockIssues: number };
  availability: { cameras24h: number | null; recorders24h: number | null; cameraSeries: AvailabilityPoint[]; recorderSeries: AvailabilityPoint[] };
  sites: DashboardSite[];
  /** Connected (DIRECT/RELAY) recorders only; the rest are summarised in `awaitingConnectivity`. */
  recorderList: DashboardRecorder[];
  awaitingConnectivity: number;
  lastCheckAt: string | null;
  offlineCameras: Array<{ id: string; name: string; site: string; recorder: string | null; detail: string | null; since: string | null }>;
  events: DashboardEvent[];
  recentAudit: Awaited<ReturnType<typeof recentAuditLogs>>;
  security: { loginFailures24h: number; activeUsers24h: number };
  streaming: { reachable: boolean; version: string | null; error?: string };
}

const HOUR = 3600_000;
/** A recorder clock this far off is flagged on the dashboard (it is corrected for playback either way). */
export const CLOCK_WARN_SECONDS = 120;

// Per-request memoisation: the estate and operations sections stream separately but share these reads.
const camerasFor = cache((user: SessionUser) => listCamerasForUser(user));
const devicesFor = cache((user: SessionUser) => listDevicesForUser(user));

const sitesFor = cache((user: SessionUser) => storeOptionsForUser(user));

/** Runs an optional read; a missing table (migration not applied yet) must not take the page down. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<{ value: T; ok: boolean }> {
  try {
    return { value: await fn(), ok: true };
  } catch (e) {
    console.warn("[dashboard] optional query failed:", (e as Error).message);
    return { value: fallback, ok: false };
  }
}

/** Memoised per request: the page header and the operations section both read it. */
export const loadDashboard = cache((user: SessionUser) => buildDashboard(user));

async function buildDashboard(user: SessionUser): Promise<DashboardData> {
  const now = new Date();
  const since = new Date(Math.floor((now.getTime() - 24 * HOUR) / HOUR) * HOUR + HOUR);
  const since24h = new Date(now.getTime() - 24 * HOUR);

  const [cams, devs, sites, streaming] = await Promise.all([
    camerasFor(user),
    devicesFor(user),
    sitesFor(user),
    mtx
      .info()
      .then((i) => ({ reachable: true, version: i.version ?? null }))
      .catch((e: Error) => ({ reachable: false, version: null, error: e.message })),
  ]);

  const enabledCams = cams.filter((c) => c.isEnabled);
  const camIds = enabledCams.map((c) => c.id);
  // Only recorders the server can reach are charted and listed; the others are not outages.
  const connected = devs.filter((d) => isConnectable(d));
  const devIds = connected.map((d) => d.id);

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

  const recorderList: DashboardRecorder[] = connected.map((d) => ({
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
    linkState: recorderLinkState(d),
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
      connected: connected.length,
      online: connected.filter((d) => d.status === "ONLINE").length,
      offline: connected.filter((d) => d.status === "OFFLINE").length,
      nvr: recordersEnabled.filter((d) => d.kind === "NVR").length,
      dvr: recordersEnabled.filter((d) => d.kind === "DVR").length,
      diskIssues: recorderList.filter((r) => r.storageHealthy === false).length,
      clockIssues: recorderList.filter((r) => Math.abs(r.clockDriftSeconds ?? 0) >= CLOCK_WARN_SECONDS).length,
    },
    availability: { cameras24h: camAvail.overall, recorders24h: devAvail.overall, cameraSeries: camAvail.series, recorderSeries: devAvail.series },
    sites: [...siteMap.values()].sort((a, b) => b.offline - a.offline || b.total - a.total || a.name.localeCompare(b.name)),
    recorderList,
    awaitingConnectivity: devs.length - connected.length,
    lastCheckAt: recorderList.map((x) => x.lastCheckedAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null,
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

// ---------------------------------------------------------------------------
// Downtime incidents
// ---------------------------------------------------------------------------

export interface IncidentItem {
  id: number;
  entityType: DowntimeEntityType;
  entityName: string;
  storeId: string | null;
  storeName: string | null;
  cameraId: string | null;
  deviceId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  detail: string | null;
  /** Camera incident caused by its recorder being down. */
  causedByRecorder: boolean;
}

/**
 * Incident visibility. Admins see everything. Others see recorder incidents of their stores and
 * camera incidents of the cameras they can see (listCamerasForUser applies store and camera grants).
 */
async function incidentScope(user: SessionUser): Promise<SQL | undefined> {
  const scope = storeScope(user);
  if (!scope) return undefined;
  const visibleCameraIds = (await camerasFor(user)).map((c) => c.id);
  const parts: SQL[] = [];
  if (scope.length) {
    const dev = and(eq(downtimeIncidents.entityType, "DEVICE"), inArray(downtimeIncidents.storeId, scope));
    if (dev) parts.push(dev);
  }
  if (visibleCameraIds.length) {
    const cam = and(eq(downtimeIncidents.entityType, "CAMERA"), inArray(downtimeIncidents.cameraId, visibleCameraIds));
    if (cam) parts.push(cam);
  }
  return parts.length ? or(...parts) : sql`false`;
}

const incidentColumns = {
  id: downtimeIncidents.id,
  entityType: downtimeIncidents.entityType,
  entityName: downtimeIncidents.entityName,
  storeId: downtimeIncidents.storeId,
  storeName: downtimeIncidents.storeName,
  cameraId: downtimeIncidents.cameraId,
  deviceId: downtimeIncidents.deviceId,
  startedAt: downtimeIncidents.startedAt,
  endedAt: downtimeIncidents.endedAt,
  durationSeconds: downtimeIncidents.durationSeconds,
  startDetail: downtimeIncidents.startDetail,
  parentIncidentId: downtimeIncidents.parentIncidentId,
};

interface IncidentSelect {
  id: number;
  entityType: DowntimeEntityType;
  entityName: string;
  storeId: string | null;
  storeName: string | null;
  cameraId: string | null;
  deviceId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  startDetail: string | null;
  parentIncidentId: number | null;
}

function toIncidentItem(r: IncidentSelect): IncidentItem {
  return {
    id: r.id,
    entityType: r.entityType,
    entityName: r.entityName,
    storeId: r.storeId,
    storeName: r.storeName,
    cameraId: r.cameraId,
    deviceId: r.deviceId,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    durationSeconds: r.durationSeconds,
    detail: r.startDetail,
    causedByRecorder: r.parentIncidentId != null,
  };
}

/** Most recent incidents (open or closed), newest first. */
export async function recentIncidentsForUser(user: SessionUser, limit = 10): Promise<{ items: IncidentItem[]; available: boolean }> {
  const where = await incidentScope(user);
  const r = await safe(() => db.select(incidentColumns).from(downtimeIncidents).where(where).orderBy(desc(downtimeIncidents.startedAt)).limit(limit), []);
  return { items: r.value.map(toIncidentItem), available: r.ok };
}

/** Incidents still open, longest-running first. Recorder outages come before the camera incidents they caused. */
export async function openIncidentsForUser(user: SessionUser, limit = 20): Promise<{ items: IncidentItem[]; total: number; available: boolean }> {
  const scope = await incidentScope(user);
  const where = and(isNull(downtimeIncidents.endedAt), scope);
  const [rows, total] = await Promise.all([
    safe(() => db.select(incidentColumns).from(downtimeIncidents).where(where).orderBy(asc(downtimeIncidents.entityType), asc(downtimeIncidents.startedAt)).limit(limit), []),
    safe(async () => Number((await db.select({ n: count() }).from(downtimeIncidents).where(where))[0]?.n ?? 0), 0),
  ]);
  // "DEVICE" sorts after "CAMERA" alphabetically; put recorders first.
  const items = rows.value.map(toIncidentItem).sort((a, b) => (a.entityType === b.entityType ? a.startedAt.localeCompare(b.startedAt) : a.entityType === "DEVICE" ? -1 : 1));
  return { items, total: total.value, available: rows.ok && total.ok };
}

export interface IncidentStats {
  available: boolean;
  openCameras: number;
  openRecorders: number;
  incidents24h: number;
  /** Camera-seconds and recorder-seconds of downtime overlapping the last 24 hours. */
  cameraDowntime24h: number;
  recorderDowntime24h: number;
}

async function incidentStatsForUser(user: SessionUser): Promise<IncidentStats> {
  const scope = await incidentScope(user);
  const since = new Date(Date.now() - 24 * HOUR);
  const sinceSql = sql`${since.toISOString()}::timestamptz`;
  const t = downtimeIncidents;
  const r = await safe(
    () =>
      db
        .select({
          entityType: t.entityType,
          open: sql<number>`count(*) filter (where ${t.endedAt} is null)`,
          started24h: sql<number>`count(*) filter (where ${t.startedAt} >= ${sinceSql})`,
          seconds: sql<number>`coalesce(sum(greatest(0, extract(epoch from (least(coalesce(${t.endedAt}, now()), now()) - greatest(${t.startedAt}, ${sinceSql}))))), 0)`,
        })
        .from(t)
        .where(and(scope, or(isNull(t.endedAt), gt(t.endedAt, since))))
        .groupBy(t.entityType),
    [],
  );
  const by = (type: DowntimeEntityType) => r.value.find((x) => x.entityType === type);
  return {
    available: r.ok,
    openCameras: Number(by("CAMERA")?.open ?? 0),
    openRecorders: Number(by("DEVICE")?.open ?? 0),
    incidents24h: Number(by("CAMERA")?.started24h ?? 0) + Number(by("DEVICE")?.started24h ?? 0),
    cameraDowntime24h: Math.round(Number(by("CAMERA")?.seconds ?? 0)),
    recorderDowntime24h: Math.round(Number(by("DEVICE")?.seconds ?? 0)),
  };
}

// ---------------------------------------------------------------------------
// Estate overview: locations, recorders by connection state, OEM coverage, readiness
// ---------------------------------------------------------------------------

export type ReadinessStatus = "ready" | "partial" | "blocked";

export interface ReadinessItem {
  key: "live" | "playback" | "permissions" | "download" | "health";
  title: string;
  status: ReadinessStatus;
  summary: string;
  details: string[];
  href: string;
}

export interface OemCoverageRow {
  id: OemGroup;
  label: string;
  recorders: number;
  connected: number;
  live: number;
  pending: number;
  cloud: number;
  cameras: number;
  protocol: string;
  notes: string;
  capabilities: Array<{ name: string; level: CapabilityLevel | "blocked"; note?: string }>;
}

export interface EstateData {
  locations: { total: number; stores: number; warehouses: number; corporate: number };
  recorders: Record<LinkState, number> & { total: number };
  cameras: { total: number; online: number; offline: number; unknown: number };
  incidents: IncidentStats;
  recentIncidents: IncidentItem[];
  coverage: OemCoverageRow[];
  readiness: ReadinessItem[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function loadEstate(user: SessionUser): Promise<EstateData> {
  const [sites, devs, cams, incidents, recent, people, alerting] = await Promise.all([
    sitesFor(user),
    devicesFor(user),
    camerasFor(user),
    incidentStatsForUser(user),
    recentIncidentsForUser(user, 10),
    user.isAdmin ? peopleStats() : Promise.resolve(null),
    alertingStats(user),
  ]);

  const states = new Map(devs.map((d) => [d.id, recorderLinkState(d)]));
  const recorders = { total: devs.length, LIVE: 0, OFFLINE: 0, CHECKING: 0, PENDING: 0, CLOUD: 0, DISABLED: 0 } satisfies EstateData["recorders"];
  for (const s of states.values()) recorders[s] += 1;
  const isConnected = (s: LinkState) => s === "LIVE" || s === "OFFLINE" || s === "CHECKING";

  const enabledCams = cams.filter((c) => c.isEnabled);
  const cameras = {
    total: enabledCams.length,
    online: enabledCams.filter((c) => c.status === "ONLINE").length,
    offline: enabledCams.filter((c) => c.status === "OFFLINE").length,
    unknown: enabledCams.filter((c) => c.status === "UNKNOWN").length,
  };

  // Coverage by OEM.
  const coverage: OemCoverageRow[] = OEM_GROUPS.map((g) => {
    const info = VENDORS[g.vendor];
    return { id: g.id, label: g.label, recorders: 0, connected: 0, live: 0, pending: 0, cloud: 0, cameras: 0, protocol: info.protocol, notes: info.notes, capabilities: [] };
  });
  const vendorOfDevice = new Map(devs.map((d) => [d.id, deviceVendorId(d)]));
  for (const d of devs) {
    const row = coverage.find((r) => r.id === oemGroupOf(vendorOfDevice.get(d.id) ?? "unknown"));
    if (!row) continue;
    const s = states.get(d.id) ?? "PENDING";
    row.recorders += 1;
    row.cameras += d.cameraCount;
    if (isConnected(s)) row.connected += 1;
    if (s === "LIVE") row.live += 1;
    if (s === "PENDING") row.pending += 1;
    if (s === "CLOUD") row.cloud += 1;
  }
  for (const row of coverage) {
    const info = VENDORS[OEM_GROUPS.find((g) => g.id === row.id)?.vendor ?? "unknown"];
    // Capability in code, but nothing to use it on: no recorder of this make is reachable.
    const blocked = row.recorders > 0 && row.connected === 0;
    const cap = (name: string, l: CapabilityLevel) =>
      blocked && l !== "unsupported"
        ? { name, level: "blocked" as const, note: `${levelWord(l)} in code, but none of these ${row.recorders} recorders is reachable from the server yet.` }
        : { name, level: l };
    row.capabilities = [cap("Live", info.live), cap("Playback", info.playback), cap("Download", info.download), cap("Health", info.health)];
  }

  // Requirement readiness, computed from what is actually connected.
  const connectedDevs = devs.filter((d) => isConnected(states.get(d.id) ?? "PENDING"));
  const notConnected = devs.length - connectedDevs.length;
  const capCount = (key: "live" | "playback" | "download") => connectedDevs.filter((d) => capabilityUsable(VENDORS[vendorOfDevice.get(d.id) ?? "unknown"][key])).length;
  const connectedCamIds = new Set(connectedDevs.map((d) => d.id));
  const liveCams = enabledCams.filter((c) => (c.deviceId ? connectedCamIds.has(c.deviceId) : Boolean(c.host))).length;
  const awaiting = [recorders.PENDING ? `${recorders.PENDING} pending network` : null, recorders.CLOUD ? `${recorders.CLOUD} cloud-only (no API)` : null].filter((x): x is string => Boolean(x));
  const tier = (n: number, gap: number): ReadinessStatus => (n === 0 ? "blocked" : gap > 0 ? "partial" : "ready");

  const liveN = capCount("live");
  const playbackN = capCount("playback");
  const downloadN = capCount("download");
  const monitored = connectedDevs.length;

  const healthDetails: string[] = [];
  if (notConnected) healthDetails.push(`${plural(notConnected, "recorder")} not monitored: no network path yet (never alerted on)`);
  if (!alerting.mailerConfigured) healthDetails.push("SMTP not configured: alert emails are kept in the outbox");
  if (alerting.recipients === 0) healthDetails.push("No alert recipients yet");
  if (!alerting.alertsEnabled) healthDetails.push("Email alerts are switched off");
  if (alerting.dailyReportEnabled) healthDetails.push(`Daily report at ${String(alerting.dailyReportHour).padStart(2, "0")}:00`);
  else healthDetails.push("Daily report is switched off");
  if (!incidents.available) healthDetails.push("Downtime log is not available yet (database migration pending)");

  const readiness: ReadinessItem[] = [
    {
      key: "live",
      title: "Live view",
      status: tier(liveN, devs.length - liveN),
      summary: liveN ? `Live on ${plural(liveN, "recorder")} · ${plural(liveCams, "camera")}` : "No recorder is reachable yet",
      details: awaiting.length ? [`Waiting: ${awaiting.join(" · ")}`] : ["Every registered recorder is connected"],
      href: "/live",
    },
    {
      key: "playback",
      title: "Playback from store NVR",
      status: tier(playbackN, devs.length - playbackN),
      summary: playbackN ? `Recorder playback on ${plural(playbackN, "recorder")}` : "No recorder with playback is reachable yet",
      details: [
        connectedDevs.length - playbackN > 0 ? `${plural(connectedDevs.length - playbackN, "connected recorder")} with unverified playback` : null,
        awaiting.length ? `Waiting: ${awaiting.join(" · ")}` : null,
      ].filter((x): x is string => Boolean(x)),
      href: "/playback",
    },
    {
      key: "permissions",
      title: "User-wise permissions",
      status: "ready",
      summary: people
        ? `${plural(people.activeNonAdmins, "user")} · ${people.withStores} with location access${people.cameraGrants != null ? ` · ${people.cameraGrants} limited to specific cameras` : ""}`
        : `You can access ${plural(sites.length, "location")}`,
      details: ["Access is granted per location, optionally narrowed to specific cameras"],
      href: can(user, "users.manage") ? "/users" : "/profile",
    },
    {
      key: "download",
      title: "Video download",
      status: tier(downloadN, devs.length - downloadN),
      summary: downloadN ? `Download available on ${plural(downloadN, "recorder")}` : "No recorder with download is reachable yet",
      details: [
        `Gated by role (${rolesFor("playback.export").map((r) => ROLE_LABELS[r]).join(", ")} by default)${people?.downloadOverrides ? ` · ${plural(people.downloadOverrides, "per-user override")}` : " with per-user overrides"}`,
        connectedDevs.some((d) => VENDORS[vendorOfDevice.get(d.id) ?? "unknown"].download === "supported") ? "Implemented, not yet proven on site" : null,
      ].filter((x): x is string => Boolean(x)),
      href: "/playback",
    },
    {
      key: "health",
      title: "Health monitoring & email alerts",
      status: monitored === 0 ? "blocked" : !alerting.mailerConfigured || alerting.recipients === 0 || !alerting.alertsEnabled || notConnected > 0 ? "partial" : "ready",
      summary: monitored ? `Monitoring ${plural(monitored, "recorder")} · ${plural(cameras.total, "camera")}` : "Nothing is reachable to monitor yet",
      details: healthDetails,
      href: can(user, "alerts.manage") ? "/alerts" : "/health",
    },
  ];

  return {
    locations: {
      total: sites.length,
      stores: sites.filter((s) => s.kind === "STORE").length,
      warehouses: sites.filter((s) => s.kind === "WAREHOUSE").length,
      corporate: sites.filter((s) => s.kind === "CORPORATE").length,
    },
    recorders,
    cameras,
    incidents,
    recentIncidents: recent.items,
    coverage,
    readiness,
  };
}

function levelWord(level: CapabilityLevel): string {
  return level === "verified" ? "Verified" : level === "supported" ? "Implemented" : level === "unverified" ? "Expected to work" : "Not available";
}

async function peopleStats(): Promise<{ activeNonAdmins: number; withStores: number; cameraGrants: number | null; downloadOverrides: number }> {
  const [nonAdmins, withStores, grants, overrides] = await Promise.all([
    safe(async () => Number((await db.select({ n: count() }).from(users).where(and(ne(users.role, "ADMIN"), eq(users.isActive, true))))[0]?.n ?? 0), 0),
    safe(
      async () =>
        Number(
          (await db.select({ n: countDistinct(userStores.userId) }).from(userStores).innerJoin(users, eq(users.id, userStores.userId)).where(and(ne(users.role, "ADMIN"), eq(users.isActive, true))))[0]?.n ?? 0,
        ),
      0,
    ),
    safe(async () => Number((await db.select({ n: countDistinct(userStores.userId) }).from(userStores).where(eq(userStores.cameraLimited, true)))[0]?.n ?? 0), 0),
    safe(async () => Number((await db.select({ n: count() }).from(users).where(isNotNull(users.allowDownload)))[0]?.n ?? 0), 0),
  ]);
  return { activeNonAdmins: nonAdmins.value, withStores: withStores.value, cameraGrants: grants.ok ? grants.value : null, downloadOverrides: overrides.value };
}

async function alertingStats(user: SessionUser): Promise<{ mailerConfigured: boolean; recipients: number; alertsEnabled: boolean; dailyReportEnabled: boolean; dailyReportHour: number }> {
  const scope = storeScope(user);
  const [settings, recipients] = await Promise.all([
    safe(() => getAlertSettings(), { offlineGraceMinutes: 3, dailyReportHour: 9, dailyReportEnabled: true, alertsEnabled: true }),
    safe(async () => {
      const where = scope
        ? and(eq(alertRecipients.isActive, true), scope.length ? or(isNull(alertRecipients.storeId), inArray(alertRecipients.storeId, scope)) : isNull(alertRecipients.storeId))
        : eq(alertRecipients.isActive, true);
      return Number((await db.select({ n: count() }).from(alertRecipients).where(where))[0]?.n ?? 0);
    }, 0),
  ]);
  return {
    mailerConfigured: getMailerStatus().configured,
    recipients: recipients.value,
    alertsEnabled: settings.value.alertsEnabled,
    dailyReportEnabled: settings.value.dailyReportEnabled,
    dailyReportHour: settings.value.dailyReportHour,
  };
}
