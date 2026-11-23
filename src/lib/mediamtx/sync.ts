import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cameras, type Camera, type Device } from "@/db/schema";
import { env } from "@/env";
import { loadDevicesFor, resolveSource, resolveSourceWith } from "@/lib/cameras/source";
import { isConnectable } from "@/lib/vendors";
import { mtx, type MtxPathConf } from "./client";

/** Prefix of short-lived playback proxy paths (see lib/playback). Never reconciled as cameras. */
export const PLAYBACK_PATH_PREFIX = "pb-";

function localRecording(camera: Camera): boolean {
  return camera.playbackMode === "LOCAL" && camera.recordEnabled;
}

/** Desired MediaMTX configuration for a camera. */
export function pathConfFor(camera: Camera, device: Device | null): MtxPathConf {
  const source = resolveSourceWith(camera, device);
  return {
    source: source.liveUrl,
    // Local recording needs a permanent pull; otherwise only pull while someone watches.
    sourceOnDemand: env.LIVE_ON_DEMAND && !localRecording(camera),
    sourceOnDemandStartTimeout: "15s",
    sourceOnDemandCloseAfter: "20s",
    rtspTransport: camera.transport,
    // Footage lives on the NVR. Local recording only for a camera explicitly in LOCAL playback mode.
    record: localRecording(camera),
    recordDeleteAfter: camera.retentionDays > 0 ? `${camera.retentionDays * 24}h` : "0s",
  };
}

function confEquals(a: MtxPathConf | null, b: MtxPathConf): boolean {
  if (!a) return false;
  return (
    a.source === b.source &&
    Boolean(a.sourceOnDemand) === Boolean(b.sourceOnDemand) &&
    (a.rtspTransport ?? "automatic") === (b.rtspTransport ?? "automatic") &&
    Boolean(a.record) === Boolean(b.record) &&
    normaliseDuration(a.recordDeleteAfter) === normaliseDuration(b.recordDeleteAfter)
  );
}

/** Seconds in a Go-style duration: "7d", "168h", and MediaMTX's own "168h0m0s" all compare equal. */
function normaliseDuration(v: string | undefined): number {
  if (!v) return 0;
  const text = v.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (!/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d))+$/.test(text)) return -1;
  const mult: Record<string, number> = { ns: 1e-9, us: 1e-6, "µs": 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400 };
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d)/g)) total += Number(m[1]) * (mult[m[2] ?? "s"] ?? 1);
  return Math.round(total * 1000) / 1000;
}

/**
 * True when MediaMTX should hold a path for this camera. A recorder channel needs a
 * connectable recorder (DIRECT/RELAY, has an address, enabled): recorders that are
 * "Pending network" or "Cloud-only" get no path, so nothing pulls from (or alerts on)
 * an address the server cannot reach. Standalone cameras need their own host.
 */
export function shouldStream(camera: Camera, device: Device | null): boolean {
  if (!camera.isEnabled) return false;
  if (device) return isConnectable(device);
  return Boolean(camera.host);
}

/** Creates or updates a single camera path. */
export async function syncCamera(camera: Camera): Promise<void> {
  const source = await resolveSource(camera);
  if (!shouldStream(camera, source.device)) {
    await mtx.deletePath(camera.pathName);
    return;
  }
  const desired = pathConfFor(camera, source.device);
  const current = await mtx.getPathConf(camera.pathName);
  if (!current) {
    await mtx.addPath(camera.pathName, desired);
  } else if (!confEquals(current, desired)) {
    await mtx.replacePath(camera.pathName, desired);
  }
}

export async function removeCameraPath(pathName: string): Promise<void> {
  await mtx.deletePath(pathName);
}

export interface SyncReport {
  added: string[];
  updated: string[];
  removed: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Reconciles every camera in the database with MediaMTX. Paths that exist in
 * MediaMTX but not in the database (and look like ours) are removed; playback
 * proxy paths are left to the playback janitor.
 */
export async function reconcileAll(): Promise<SyncReport> {
  const report: SyncReport = { added: [], updated: [], removed: [], errors: [] };
  const [all, existing] = await Promise.all([db.select().from(cameras), mtx.listPathConfs()]);
  const deviceMap = await loadDevicesFor(all);
  const existingByName = new Map(existing.filter((c) => c.name).map((c) => [c.name as string, c]));
  const wanted = new Set<string>();

  for (const camera of all) {
    const device = camera.deviceId ? (deviceMap.get(camera.deviceId) ?? null) : null;
    if (!shouldStream(camera, device)) continue;
    wanted.add(camera.pathName);
    try {
      const desired = pathConfFor(camera, device);
      const current = existingByName.get(camera.pathName) ?? null;
      if (!current) {
        await mtx.addPath(camera.pathName, desired);
        report.added.push(camera.pathName);
      } else if (!confEquals(current, desired)) {
        await mtx.replacePath(camera.pathName, desired);
        report.updated.push(camera.pathName);
      }
    } catch (e) {
      report.errors.push({ path: camera.pathName, error: (e as Error).message });
    }
  }

  for (const conf of existing) {
    const name = conf.name;
    if (!name || name === "all_others" || name === "all" || wanted.has(name)) continue;
    if (name.startsWith(PLAYBACK_PATH_PREFIX)) continue;
    // Only remove paths that are static RTSP sources (i.e. created by this app).
    if (!conf.source || !/^rtsps?:\/\//i.test(conf.source)) continue;
    try {
      await mtx.deletePath(name);
      report.removed.push(name);
    } catch (e) {
      report.errors.push({ path: name, error: (e as Error).message });
    }
  }
  return report;
}

export async function syncCameraById(cameraId: string): Promise<void> {
  const camera = await db.query.cameras.findFirst({ where: eq(cameras.id, cameraId) });
  if (camera) await syncCamera(camera);
}

/** Re-syncs every camera of a device (after its credentials or host change). */
export async function syncDeviceCameras(deviceId: string): Promise<void> {
  const list = await db.select().from(cameras).where(eq(cameras.deviceId, deviceId));
  for (const cam of list) {
    try {
      await syncCamera(cam);
    } catch {
      // reconciliation retries every minute
    }
  }
}
