import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { devices, type Camera, type Device } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { buildRtspUrl, type RtspParts } from "@/lib/rtsp";
import { buildLiveRtspUrlPath, canBuildChannelPath, isAutoHikvisionPath, protocolFamilyOf, type ProtocolFamily } from "@/lib/vendors";
import { channelFromRtspPath as parseChannel, hikvisionLivePath as hikPath } from "@/lib/vendors/rtsp-paths";

/**
 * Resolves where a camera's video actually comes from. Channels of a recorder
 * inherit the recorder's host, RTSP port and credentials; standalone cameras
 * carry their own. Secrets are decrypted here and must never leave the server.
 */
export interface ResolvedSource extends RtspParts {
  device: Device | null;
  /** Hikvision track id for playback/search: channel*100 + 1 (main) */
  trackId: number | null;
  /** Channel number on the recorder, when known. */
  channel: number | null;
  /** Protocol family of the recorder (null for standalone cameras). */
  family: ProtocolFamily | null;
  liveUrl: string;
}

/** Kept for existing callers (channel import, camera actions). Same output as before. */
export function hikvisionLivePath(channel: number, subStream = false): string {
  return hikPath(channel, subStream);
}

/** Channel number from a stored path (Hikvision channels/tracks, or Dahua ?channel=N). */
export function channelFromRtspPath(rtspPath: string): number | null {
  return parseChannel(rtspPath);
}

/**
 * Live path for a recorder channel.
 *  - An explicit camera path always wins, except the Hikvision path that older
 *    forms auto-filled for every recorder: on a recorder of another family that
 *    can build its own path (CP Plus/Dahua, or a template), it is regenerated.
 *  - Otherwise the vendor builder decides; Hikvision/Tyco output is unchanged.
 */
function channelPath(camera: Camera, device: Device, channel: number | null): string {
  const explicit = camera.rtspPath && camera.rtspPath !== "/" ? camera.rtspPath : null;
  const family = protocolFamilyOf(device.vendor);
  if (explicit) {
    const stale = channel !== null && family !== "isapi" && canBuildChannelPath(device) && isAutoHikvisionPath(explicit, channel);
    if (!stale) return explicit;
  }
  return channel ? buildLiveRtspUrlPath(device, channel) : "/";
}

export function resolveSourceWith(camera: Camera, device: Device | null): ResolvedSource {
  const channel = camera.channel ?? channelFromRtspPath(camera.rtspPath);
  if (device) {
    const parts: RtspParts = {
      host: device.host,
      port: device.rtspPort,
      username: device.username,
      password: device.passwordEnc ? decryptSecret(device.passwordEnc) : null,
      path: channelPath(camera, device, channel),
    };
    return { ...parts, device, channel, family: protocolFamilyOf(device.vendor), trackId: channel ? channel * 100 + 1 : null, liveUrl: buildRtspUrl(parts) };
  }
  const parts: RtspParts = {
    host: camera.host ?? "",
    port: camera.port,
    username: camera.username,
    password: camera.passwordEnc ? decryptSecret(camera.passwordEnc) : null,
    path: camera.rtspPath || "/",
  };
  return { ...parts, device: null, channel, family: null, trackId: channel ? channel * 100 + 1 : null, liveUrl: buildRtspUrl(parts) };
}

export async function resolveSource(camera: Camera): Promise<ResolvedSource> {
  const device = camera.deviceId ? ((await db.query.devices.findFirst({ where: eq(devices.id, camera.deviceId) })) ?? null) : null;
  return resolveSourceWith(camera, device);
}

/** Loads devices for a batch of cameras in one query. */
export async function loadDevicesFor(cams: Camera[]): Promise<Map<string, Device>> {
  const ids = [...new Set(cams.map((c) => c.deviceId).filter((v): v is string => Boolean(v)))];
  const map = new Map<string, Device>();
  if (ids.length === 0) return map;
  const rows = await db.select().from(devices).where(inArray(devices.id, ids));
  for (const d of rows) map.set(d.id, d);
  return map;
}
