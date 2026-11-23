import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { playbackSessions, stores, type Camera, type Device } from "@/db/schema";
import { env } from "@/env";
import { resolveSource } from "@/lib/cameras/source";
import { deviceClock, getClock, hasDetectedOffset, playbackRtspUrl, rememberDetectedOffset, toDeviceTime } from "@/lib/hikvision/isapi";
import { devices } from "@/db/schema";
import { mtx, type MtxPathConf } from "@/lib/mediamtx/client";
import { PLAYBACK_PATH_PREFIX } from "@/lib/mediamtx/sync";
import { isConnectable, isIsapiVendor, vendorLabel } from "@/lib/vendors";
import { playbackRtspUrlFor } from "@/lib/vendors/adapters";

/**
 * NVR playback without local storage. Each request creates a short-lived,
 * on-demand MediaMTX path whose source is the recorder's own RTSP playback
 * URL (/Streaming/tracks/<ch>01?starttime=..&endtime=..). The browser reads
 * it over WebRTC/HLS exactly like a live stream; the janitor removes the path
 * once nobody is watching. Frames pass through memory only.
 */

export class PlaybackError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Grace period before an unwatched session is torn down (covers the WHEP/ICE handshake and NVR seek). */
const IDLE_GRACE_MS = 90_000;

export interface PlaybackContext {
  camera: Camera;
  device: Device;
  trackId: number;
  /** Channel number on the recorder (trackId = channel*100 + 1). */
  channel: number;
  siteTimeZone: string;
}

/** Validates that a camera can be played back from its recorder and returns what is needed to do so. */
export async function playbackContext(camera: Camera): Promise<PlaybackContext> {
  if (camera.playbackMode !== "NVR") throw new PlaybackError("This camera does not use recorder playback.");
  const source = await resolveSource(camera);
  if (!source.device) throw new PlaybackError("This camera is not linked to a recorder (NVR/DVR). Link it on the Cameras page.");
  if (!source.device.isEnabled) throw new PlaybackError("The recorder for this camera is disabled.");
  // Pending-network / cloud-only recorders (often private store-LAN addresses) must never be dialled
  // with their stored credentials: the address may belong to something else on the server's network.
  if (!isConnectable(source.device)) throw new PlaybackError("Recorder is not reachable from the server", 409);
  if (!source.trackId) throw new PlaybackError("The camera has no channel number on its recorder.");
  const site = await db.query.stores.findFirst({ where: eq(stores.id, camera.storeId), columns: { timezone: true } });
  let device = source.device;
  // First use before the background check has measured the recorder clock: measure it now.
  // Measure the recorder clock when drift is unknown or this process has not read its UTC offset yet (e.g. after a restart).
  if (isIsapiVendor(device.vendor) && (device.clockDriftSeconds == null || (device.utcOffsetMinutes == null && !hasDetectedOffset(device.id)))) {
    try {
      const clock = await getClock(device);
      rememberDetectedOffset(device.id, clock.offsetMinutes);
      if (clock.driftSeconds != null) {
        await db.update(devices).set({ clockDriftSeconds: clock.driftSeconds }).where(eq(devices.id, device.id));
        device = { ...device, clockDriftSeconds: clock.driftSeconds };
      }
    } catch {
      // fall back to the site timezone and no drift
    }
  }
  return { camera, device, trackId: source.trackId, channel: source.channel ?? Math.floor(source.trackId / 100), siteTimeZone: site?.timezone ?? "Asia/Kolkata" };
}

export interface CreatedSession {
  id: string;
  pathName: string;
  startAt: Date;
  endAt: Date;
}

export async function createPlaybackSession(camera: Camera, userId: string, start: Date, requestedEnd: Date | null): Promise<CreatedSession> {
  const ctx = await playbackContext(camera);
  const now = Date.now();
  if (Number.isNaN(start.getTime())) throw new PlaybackError("Invalid start time.");
  if (start.getTime() > now - 5_000) throw new PlaybackError("Start time must be in the past.");

  const maxMs = env.NVR_PLAYBACK_MAX_MINUTES * 60_000;
  let end = requestedEnd && !Number.isNaN(requestedEnd.getTime()) ? requestedEnd : new Date(start.getTime() + maxMs);
  if (end.getTime() > now) end = new Date(now);
  if (end.getTime() - start.getTime() > maxMs) end = new Date(start.getTime() + maxMs);
  if (end.getTime() - start.getTime() < 5_000) throw new PlaybackError("The playback window is too short.");

  const clock = deviceClock(ctx.device, ctx.siteTimeZone);
  const isapi = isIsapiVendor(ctx.device.vendor);
  // Hikvision/Tyco keep the exact ISAPI track URL; Dahua-family recorders (CP Plus) use /cam/playback.
  const source = isapi ? playbackRtspUrl(ctx.device, ctx.trackId, start, end, clock) : playbackRtspUrlFor(ctx.device, ctx.channel, start, end, clock);
  if (!source) throw new PlaybackError(`Recorder playback is not yet supported for ${vendorLabel(ctx.device.vendor)}.`, 501);
  const pathName = `${PLAYBACK_PATH_PREFIX}${randomBytes(8).toString("hex")}`;
  const conf: MtxPathConf = {
    source,
    sourceOnDemand: true,
    sourceOnDemandStartTimeout: "25s",
    sourceOnDemandCloseAfter: "5s",
    rtspTransport: camera.transport === "udp" ? "udp" : "tcp",
    record: false,
    // The Range: clock= header is part of the Hikvision playback spec only.
    ...(isapi && env.NVR_PLAYBACK_RANGE_HEADER ? { rtspRangeType: "clock" as const, rtspRangeStart: toDeviceTime(start, clock, "compact") } : {}),
  };

  // Record the session first so the janitor never sees the new path as an orphan.
  const [row] = await db
    .insert(playbackSessions)
    .values({ cameraId: camera.id, userId, pathName, startAt: start, endAt: end })
    .returning({ id: playbackSessions.id });
  if (!row) throw new PlaybackError("Could not create the playback session.", 500);
  try {
    await mtx.addPath(pathName, conf);
  } catch (e) {
    await db.delete(playbackSessions).where(eq(playbackSessions.id, row.id));
    throw e;
  }
  return { id: row.id, pathName, startAt: start, endAt: end };
}

/**
 * Closes a session. `userId` is the caller for non-admins (undefined = admin): a non-admin may only
 * close their own session, and a session without an owner (its user was deleted) is admin-only.
 */
export async function closePlaybackSession(id: string, userId?: string): Promise<boolean> {
  const row = await db.query.playbackSessions.findFirst({ where: eq(playbackSessions.id, id) });
  if (!row || row.closedAt) return false;
  if (userId !== undefined && row.userId !== userId) return false;
  await mtx.deletePath(row.pathName).catch(() => undefined);
  await db.update(playbackSessions).set({ closedAt: new Date() }).where(eq(playbackSessions.id, id));
  return true;
}

/**
 * Closes sessions nobody is reading any more (or that outlived their window)
 * and removes orphaned playback paths left behind by a restart.
 */
export async function cleanupPlaybackSessions(): Promise<number> {
  const open = await db.select().from(playbackSessions).where(isNull(playbackSessions.closedAt));
  const now = Date.now();
  let closed = 0;

  for (const s of open) {
    const age = now - s.createdAt.getTime();
    const windowMs = s.endAt.getTime() - s.startAt.getTime();
    let stale = age > windowMs + 30 * 60_000;
    if (!stale && age > IDLE_GRACE_MS) {
      try {
        const p = await mtx.getPath(s.pathName);
        stale = !p || (p.readers?.length ?? 0) === 0;
      } catch {
        // streaming server unreachable: try again next round
      }
    }
    if (stale) {
      await mtx.deletePath(s.pathName).catch(() => undefined);
      await db.update(playbackSessions).set({ closedAt: new Date() }).where(eq(playbackSessions.id, s.id));
      closed += 1;
    } else {
      await db.update(playbackSessions).set({ lastSeenAt: new Date() }).where(eq(playbackSessions.id, s.id));
    }
  }

  // Orphans: playback paths MediaMTX still has but we no longer track.
  try {
    const confs = await mtx.listPathConfs();
    // Re-read after listing so a session created meanwhile is never treated as an orphan.
    const stillOpen = await db.select({ pathName: playbackSessions.pathName }).from(playbackSessions).where(isNull(playbackSessions.closedAt));
    const openNames = new Set(stillOpen.map((s) => s.pathName));
    for (const conf of confs) {
      const name = conf.name ?? "";
      if (name.startsWith(PLAYBACK_PATH_PREFIX) && !openNames.has(name)) {
        await mtx.deletePath(name).catch(() => undefined);
        closed += 1;
      }
    }
  } catch {
    // streaming server unreachable
  }

  // Forget closed sessions after a week.
  await db.delete(playbackSessions).where(and(lt(playbackSessions.createdAt, new Date(now - 7 * 86400_000))));
  return closed;
}
