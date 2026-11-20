import "server-only";
import net from "node:net";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { cameras, cameraStatusEvents, settings, type Camera, type CameraStatus } from "@/db/schema";
import { env } from "@/env";
import { loadDevicesFor } from "@/lib/cameras/source";
import { runDeviceHealthCheck } from "@/lib/devices/health";
import { getChannelStatus, type ChannelStatus } from "@/lib/hikvision/isapi";
import { describeTracks, mtx, type MtxPath } from "@/lib/mediamtx/client";

export interface HealthRunResult {
  checkedAt: Date;
  total: number;
  online: number;
  offline: number;
  unknown: number;
  transitions: Array<{ cameraId: string; name: string; from: CameraStatus; to: CameraStatus }>;
  /** Recorders (NVR/DVR) probed in the same run. */
  devicesTotal: number;
  devicesOnline: number;
  devicesOffline: number;
  deviceTransitions: Array<{ deviceId: string; name: string; from: CameraStatus; to: CameraStatus }>;
  mediamtxReachable: boolean;
  error?: string;
}

/** TCP reachability probe: tells "host down" apart from "stream not negotiated". */
export function tcpProbe(host: string, port: number, timeoutMs = env.HEALTH_TCP_TIMEOUT_MS): Promise<{ ok: boolean; latencyMs: number | null; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: ok ? Date.now() - started : null, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false, "Connection timed out"));
    socket.once("error", (err) => done(false, err.message));
    socket.connect(port, host);
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __vmsHealthRunning: boolean | undefined;
}
/** Shared across server bundles (scheduler and API routes) so runs never overlap. */
const runState = {
  get value() {
    return globalThis.__vmsHealthRunning === true;
  },
  set value(v: boolean) {
    globalThis.__vmsHealthRunning = v;
  },
};

/**
 * Checks every enabled camera against MediaMTX (source online?) plus a TCP
 * probe of the device, persists status changes as events and updates the
 * camera row. Safe to call concurrently: overlapping runs are skipped.
 */
export async function runHealthCheck(): Promise<HealthRunResult> {
  const checkedAt = new Date();
  if (runState.value) {
    return { checkedAt, total: 0, online: 0, offline: 0, unknown: 0, transitions: [], devicesTotal: 0, devicesOnline: 0, devicesOffline: 0, deviceTransitions: [], mediamtxReachable: true, error: "A check is already running" };
  }
  runState.value = true;
  try {
    // Recorders first: their reachability explains most channel outages.
    let deviceRun = { total: 0, online: 0, offline: 0, transitions: [] as HealthRunResult["deviceTransitions"] };
    try {
      deviceRun = await runDeviceHealthCheck();
    } catch (e) {
      console.error("[health] recorder check failed", e);
    }

    const all = await db.select().from(cameras);
    let paths: Map<string, MtxPath> | null = null;
    let mtxError: string | undefined;
    try {
      const list = await mtx.listPaths();
      paths = new Map(list.map((p) => [p.name, p]));
    } catch (e) {
      mtxError = (e as Error).message;
    }

    const result: HealthRunResult = {
      checkedAt,
      total: all.length,
      online: 0,
      offline: 0,
      unknown: 0,
      transitions: [],
      devicesTotal: deviceRun.total,
      devicesOnline: deviceRun.online,
      devicesOffline: deviceRun.offline,
      deviceTransitions: deviceRun.transitions,
      mediamtxReachable: paths !== null,
      error: mtxError,
    };

    // Channels inherit their recorder's address; standalone cameras use their own.
    const deviceMap = await loadDevicesFor(all);
    const endpointOf = (c: Camera): string | null => {
      const d = c.deviceId ? deviceMap.get(c.deviceId) : null;
      if (d) return `${d.host}:${d.rtspPort}`;
      return c.host ? `${c.host}:${c.port}` : null;
    };

    // Probe devices in parallel but bounded, so a large estate does not open hundreds of sockets at once.
    const probes = new Map<string, Awaited<ReturnType<typeof tcpProbe>>>();
    const hosts = [...new Set(all.filter((c) => c.isEnabled).map(endpointOf).filter((v): v is string => Boolean(v)))];
    const CONCURRENCY = 8;
    for (let i = 0; i < hosts.length; i += CONCURRENCY) {
      const batch = hosts.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (hp) => {
          const [host, port] = hp.split(":");
          return [hp, await tcpProbe(host ?? "", Number(port))] as const;
        }),
      );
      for (const [hp, r] of results) probes.set(hp, r);
    }

    // Ask each online recorder which of its channels are connected. This needs no
    // video, so it works with on-demand live streams and without the streaming server.
    const channelStatus = new Map<string, Map<number, ChannelStatus>>();
    const channelStatusError = new Map<string, string>();
    const recorders = [...deviceMap.values()].filter((d) => d.isEnabled && d.status === "ONLINE" && d.vendor === "hikvision" && d.kind !== "CAMERA");
    await Promise.all(
      recorders.map(async (d) => {
        try {
          channelStatus.set(d.id, await getChannelStatus(d));
        } catch (e) {
          channelStatusError.set(d.id, (e as Error).message);
        }
      }),
    );

    for (const camera of all) {
      const previous = camera.status;
      let next: CameraStatus;
      let detail: string | null = null;
      let latency: number | null = null;
      let codecs = { videoCodec: camera.videoCodec, audioCodec: camera.audioCodec, resolution: camera.resolution };
      let readers = 0;

      const device = camera.deviceId ? (deviceMap.get(camera.deviceId) ?? null) : null;
      const endpoint = endpointOf(camera);
      const probe = endpoint ? probes.get(endpoint) : undefined;
      const p = paths?.get(camera.pathName);
      if (p?.online) {
        codecs = describeTracks(p.tracks2 ?? p.tracks);
        readers = p.readers?.length ?? 0;
      }
      latency = probe?.latencyMs ?? null;
      const chan = device && camera.channel ? channelStatus.get(device.id)?.get(camera.channel) : undefined;

      if (!camera.isEnabled) {
        next = "UNKNOWN";
        detail = "Camera disabled";
      } else if (device && !device.isEnabled) {
        next = "UNKNOWN";
        detail = "Recorder disabled";
      } else if (device && device.status === "OFFLINE") {
        next = "OFFLINE";
        detail = `Recorder ${device.name} is offline`;
      } else if (chan) {
        next = chan.online ? "ONLINE" : "OFFLINE";
        if (!chan.online) detail = `Recorder reports channel ${camera.channel} ${chan.detail ? `"${chan.detail}"` : "disconnected"}${chan.ipAddress ? ` (camera ${chan.ipAddress})` : ""}`;
      } else if (device && device.kind === "NVR" && camera.channel && channelStatus.has(device.id)) {
        // NVR status lists every IP channel; a missing one really is not configured.
        // (DVRs list only their IP channels here, so analog channels fall through.)
        next = "OFFLINE";
        detail = `Channel ${camera.channel} does not exist on ${device.name}`;
      } else if (p?.online) {
        next = "ONLINE";
      } else if (device && channelStatusError.has(device.id)) {
        // The recorder answers but would not report channel states: do not guess "online".
        next = "UNKNOWN";
        detail = `Recorder channel status unavailable: ${channelStatusError.get(device.id)}`;
      } else if (!endpoint) {
        next = "OFFLINE";
        detail = "No recorder or host configured";
      } else if (probe && !probe.ok) {
        next = "OFFLINE";
        detail = `Device unreachable on ${endpoint} (${probe.error ?? "no response"})`;
      } else if (probe?.ok && env.LIVE_ON_DEMAND) {
        // On-demand live paths are idle until viewed; a reachable device counts as online.
        next = "ONLINE";
      } else if (!paths) {
        next = "UNKNOWN";
        detail = `Streaming server unreachable: ${mtxError ?? "unknown error"}`;
      } else {
        next = "OFFLINE";
        detail = "Device reachable but RTSP stream is not online (check credentials/channel)";
      }

      if (next === "ONLINE") result.online += 1;
      else if (next === "OFFLINE") result.offline += 1;
      else result.unknown += 1;

      await db
        .update(cameras)
        .set({
          status: next,
          lastCheckedAt: checkedAt,
          lastOnlineAt: next === "ONLINE" ? checkedAt : camera.lastOnlineAt,
          lastError: next === "ONLINE" ? null : detail,
          lastLatencyMs: latency,
          videoCodec: codecs.videoCodec,
          audioCodec: codecs.audioCodec,
          resolution: codecs.resolution,
          readerCount: readers,
        })
        .where(eq(cameras.id, camera.id));

      if (previous !== next) {
        await db.insert(cameraStatusEvents).values({ cameraId: camera.id, status: next, detail, createdAt: checkedAt });
        result.transitions.push({ cameraId: camera.id, name: camera.name, from: previous, to: next });
      }
    }

    await db
      .insert(settings)
      .values({ key: "health.lastRun", value: JSON.stringify({ at: checkedAt.toISOString(), online: result.online, offline: result.offline, unknown: result.unknown, devicesOnline: result.devicesOnline, devicesOffline: result.devicesOffline, mediamtxReachable: result.mediamtxReachable }) })
      .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value`, updatedAt: new Date() } });

    return result;
  } finally {
    runState.value = false;
  }
}


/** Percentage of time a camera was ONLINE in the window, derived from status events. */
export async function uptimeFor(cameraIds: string[], since: Date, until: Date = new Date()): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (cameraIds.length === 0) return out;

  const events = await db
    .select()
    .from(cameraStatusEvents)
    .where(and(inArray(cameraStatusEvents.cameraId, cameraIds), gte(cameraStatusEvents.createdAt, since)))
    .orderBy(cameraStatusEvents.cameraId, cameraStatusEvents.createdAt);

  // Status in force at the window start = last event before `since`.
  const baseline = new Map<string, CameraStatus>();
  for (const id of cameraIds) {
    const last = await db
      .select({ status: cameraStatusEvents.status })
      .from(cameraStatusEvents)
      .where(and(eq(cameraStatusEvents.cameraId, id), lt(cameraStatusEvents.createdAt, since)))
      .orderBy(desc(cameraStatusEvents.createdAt))
      .limit(1);
    baseline.set(id, last[0]?.status ?? "UNKNOWN");
  }

  const byCamera = new Map<string, typeof events>();
  for (const e of events) {
    const list = byCamera.get(e.cameraId) ?? [];
    list.push(e);
    byCamera.set(e.cameraId, list);
  }

  const windowMs = until.getTime() - since.getTime();
  for (const id of cameraIds) {
    const list = byCamera.get(id) ?? [];
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

export async function recentStatusEvents(limit = 50, cameraIds?: string[]) {
  const where = cameraIds ? inArray(cameraStatusEvents.cameraId, cameraIds) : undefined;
  return db.query.cameraStatusEvents.findMany({
    where,
    orderBy: desc(cameraStatusEvents.createdAt),
    limit,
    with: { camera: { with: { store: true } } },
  });
}

export type CameraWithStore = Camera & { store: { id: string; name: string; code: string } };
