import "server-only";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { cameras, devices, deviceStatusEvents, type CameraStatus, type Device } from "@/db/schema";
import { tcpProbe } from "@/lib/health/monitor";
import { isConnectable } from "@/lib/vendors";

/**
 * Why the server does not probe a recorder, or null when it should.
 * PENDING_NETWORK / CLOUD_ONLY / disabled / address-less recorders are listed but never
 * probed, streamed from or alerted on: their status stays UNKNOWN with this reason.
 */
export function notMonitoredReason(device: Pick<Device, "connectionMode" | "host" | "isEnabled">): string | null {
  if (!device.isEnabled) return "Recorder disabled";
  if (isConnectable(device)) return null;
  switch (device.connectionMode) {
    case "PENDING_NETWORK":
      return "Awaiting network route: the recorder is not reachable from the server yet";
    case "CLOUD_ONLY":
      return "Cloud-only: no supported API";
    default:
      return "No recorder address configured";
  }
}

/** Extra facts a vendor integration can read off the recorder itself. */
export interface DeviceInfo {
  model?: string | null;
  serialNumber?: string | null;
  firmware?: string | null;
  channelCount?: number | null;
  storageStatus?: string | null;
  storageTotalMb?: number | null;
  storageFreeMb?: number | null;
  infoCheckedAt?: Date;
  clockDriftSeconds?: number | null;
}

/**
 * Optional enrichment hook. When another module sets this (e.g. a Hikvision
 * ISAPI client registering `deviceInfoProvider = fetchIsapiDeviceInfo`), the
 * health check calls it for every reachable, enabled recorder and copies the
 * returned fields (model, serial number, firmware, channel count, storage
 * status) onto the device row. It is intentionally left `null` here: the TCP
 * probe alone keeps working without any vendor-specific code. The provider
 * receives the raw device row (with the encrypted password) and must never let
 * the secret leave the server. Errors it throws are recorded as `lastError`
 * but do not change the ONLINE/OFFLINE status.
 */
export type DeviceInfoProvider = (device: Device) => Promise<DeviceInfo | null>;

declare global {
  // eslint-disable-next-line no-var
  var __vmsDeviceInfoProvider: DeviceInfoProvider | null | undefined;
}

/** Current enrichment hook (kept on globalThis so every server bundle sees the same one). */
export function getDeviceInfoProvider(): DeviceInfoProvider | null {
  return globalThis.__vmsDeviceInfoProvider ?? null;
}

/** Registers (or clears) the enrichment hook. */
export function setDeviceInfoProvider(provider: DeviceInfoProvider | null): void {
  globalThis.__vmsDeviceInfoProvider = provider;
}

export interface DeviceHealthRunResult {
  checkedAt: Date;
  total: number;
  online: number;
  offline: number;
  unknown: number;
  /** Recorders not probed because they are disabled, pending a network route or cloud-only. */
  skipped: number;
  transitions: Array<{ deviceId: string; name: string; from: CameraStatus; to: CameraStatus }>;
}

const CONCURRENCY = 8;

/**
 * TCP-probes every recorder's RTSP port (plus its HTTP port for diagnostics),
 * persists the status on the device row and records transitions as events.
 * A recorder counts as ONLINE when its RTSP port accepts connections, because
 * that is the port the streaming server and playback depend on.
 */
export async function runDeviceHealthCheck(): Promise<DeviceHealthRunResult> {
  const checkedAt = new Date();
  const all = await db.select().from(devices);
  const result: DeviceHealthRunResult = { checkedAt, total: all.length, online: 0, offline: 0, unknown: 0, skipped: 0, transitions: [] };

  for (let i = 0; i < all.length; i += CONCURRENCY) {
    const batch = all.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((device) => checkDevice(device, checkedAt, result)));
  }
  return result;
}

async function checkDevice(device: Device, checkedAt: Date, result: DeviceHealthRunResult): Promise<void> {
  const previous = device.status;
  let next: CameraStatus;
  let detail: string | null = null;
  let latency: number | null = null;
  let info: DeviceInfo | null = null;

  const skipReason = notMonitoredReason(device);
  if (skipReason) {
    // Never probe: an empty host would hit localhost, and private store IPs are not routable from here.
    next = "UNKNOWN";
    detail = skipReason;
    result.skipped += 1;
  } else {
    const [rtsp, http] = await Promise.all([tcpProbe(device.host, device.rtspPort), tcpProbe(device.host, device.httpPort)]);
    latency = rtsp.latencyMs ?? http.latencyMs;
    if (rtsp.ok) {
      next = "ONLINE";
      if (!http.ok) detail = `RTSP ${device.rtspPort} answered but HTTP ${device.httpPort} did not (${http.error ?? "no response"})`;
    } else {
      next = "OFFLINE";
      detail = http.ok
        ? `HTTP ${device.httpPort} answered but RTSP ${device.rtspPort} did not (${rtsp.error ?? "no response"}): check the recorder's RTSP service`
        : `Recorder unreachable on ${device.host} (${rtsp.error ?? "no response"})`;
    }

    const provider = getDeviceInfoProvider();
    if (next === "ONLINE" && provider) {
      try {
        info = await provider(device);
      } catch (e) {
        detail = `Device info unavailable: ${(e as Error).message}`;
      }
    }
  }

  if (next === "ONLINE") result.online += 1;
  else if (next === "OFFLINE") result.offline += 1;
  else result.unknown += 1;

  await db
    .update(devices)
    .set({
      status: next,
      lastCheckedAt: checkedAt,
      lastOnlineAt: next === "ONLINE" ? checkedAt : device.lastOnlineAt,
      lastError: detail,
      lastLatencyMs: latency,
      ...(info?.model !== undefined ? { model: info.model } : {}),
      ...(info?.serialNumber !== undefined ? { serialNumber: info.serialNumber } : {}),
      ...(info?.firmware !== undefined ? { firmware: info.firmware } : {}),
      ...(info?.channelCount !== undefined ? { channelCount: info.channelCount } : {}),
      ...(info?.storageStatus !== undefined ? { storageStatus: info.storageStatus } : {}),
      ...(info?.storageTotalMb !== undefined ? { storageTotalMb: info.storageTotalMb } : {}),
      ...(info?.storageFreeMb !== undefined ? { storageFreeMb: info.storageFreeMb } : {}),
      ...(info?.infoCheckedAt !== undefined ? { infoCheckedAt: info.infoCheckedAt } : {}),
      ...(info?.clockDriftSeconds !== undefined ? { clockDriftSeconds: info.clockDriftSeconds } : {}),
    })
    .where(eq(devices.id, device.id));

  if (previous !== next) {
    await db.insert(deviceStatusEvents).values({ deviceId: device.id, status: next, detail, createdAt: checkedAt });
    result.transitions.push({ deviceId: device.id, name: device.name, from: previous, to: next });
  }
}

/** Percentage of time a recorder was ONLINE in the window, derived from status events. */
export async function deviceUptimeFor(deviceIds: string[], since: Date, until: Date = new Date()): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (deviceIds.length === 0) return out;

  const events = await db
    .select()
    .from(deviceStatusEvents)
    .where(and(inArray(deviceStatusEvents.deviceId, deviceIds), gte(deviceStatusEvents.createdAt, since)))
    .orderBy(deviceStatusEvents.deviceId, deviceStatusEvents.createdAt);

  const baseline = new Map<string, CameraStatus>();
  for (const id of deviceIds) {
    const last = await db
      .select({ status: deviceStatusEvents.status })
      .from(deviceStatusEvents)
      .where(and(eq(deviceStatusEvents.deviceId, id), lt(deviceStatusEvents.createdAt, since)))
      .orderBy(desc(deviceStatusEvents.createdAt))
      .limit(1);
    baseline.set(id, last[0]?.status ?? "UNKNOWN");
  }

  const byDevice = new Map<string, typeof events>();
  for (const e of events) {
    const list = byDevice.get(e.deviceId) ?? [];
    list.push(e);
    byDevice.set(e.deviceId, list);
  }

  const windowMs = until.getTime() - since.getTime();
  for (const id of deviceIds) {
    const list = byDevice.get(id) ?? [];
    let status = baseline.get(id) ?? "UNKNOWN";
    let cursor = since.getTime();
    let onlineMs = 0;
    let knownMs = 0;
    for (const e of list) {
      const t = Math.min(e.createdAt.getTime(), until.getTime());
      if (status !== "UNKNOWN") knownMs += t - cursor;
      if (status === "ONLINE") onlineMs += t - cursor;
      status = e.status;
      cursor = t;
    }
    if (status !== "UNKNOWN") knownMs += until.getTime() - cursor;
    if (status === "ONLINE") onlineMs += until.getTime() - cursor;
    out.set(id, knownMs <= 0 || windowMs <= 0 ? null : Math.round((onlineMs / knownMs) * 1000) / 10);
  }
  return out;
}

/** Latest recorder transitions, optionally limited to a set of devices. */
export async function recentDeviceStatusEvents(limit = 50, deviceIds?: string[]) {
  if (deviceIds && deviceIds.length === 0) return [];
  return db.query.deviceStatusEvents.findMany({
    where: deviceIds ? inArray(deviceStatusEvents.deviceId, deviceIds) : undefined,
    orderBy: desc(deviceStatusEvents.createdAt),
    limit,
    with: { device: { with: { store: true } } },
  });
}

/** Linked camera counts per recorder (online / total), for cards and API payloads. */
export async function cameraCountsByDevice(deviceIds: string[]): Promise<Map<string, { total: number; online: number }>> {
  const out = new Map<string, { total: number; online: number }>();
  if (deviceIds.length === 0) return out;
  const rows = await db.select({ deviceId: cameras.deviceId, status: cameras.status }).from(cameras).where(inArray(cameras.deviceId, deviceIds));
  for (const r of rows) {
    if (!r.deviceId) continue;
    const c = out.get(r.deviceId) ?? { total: 0, online: 0 };
    c.total += 1;
    if (r.status === "ONLINE") c.online += 1;
    out.set(r.deviceId, c);
  }
  return out;
}
