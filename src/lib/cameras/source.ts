import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { devices, type Camera, type Device } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { buildRtspUrl, type RtspParts } from "@/lib/rtsp";

/**
 * Resolves where a camera's video actually comes from. Channels of a recorder
 * inherit the recorder's host, RTSP port and credentials; standalone cameras
 * carry their own. Secrets are decrypted here and must never leave the server.
 */
export interface ResolvedSource extends RtspParts {
  device: Device | null;
  /** Hikvision track id for playback/search: channel*100 + 1 (main) */
  trackId: number | null;
  liveUrl: string;
}

export function hikvisionLivePath(channel: number, subStream = false): string {
  return `/Streaming/Unicast/channels/${channel}${subStream ? "02" : "01"}`;
}

export function channelFromRtspPath(rtspPath: string): number | null {
  const m = /channels\/(\d+?)(0[12])$/i.exec(rtspPath) ?? /tracks\/(\d+?)(0[12])$/i.exec(rtspPath);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function resolveSourceWith(camera: Camera, device: Device | null): ResolvedSource {
  const channel = camera.channel ?? channelFromRtspPath(camera.rtspPath);
  if (device) {
    const path = camera.rtspPath && camera.rtspPath !== "/" ? camera.rtspPath : channel ? hikvisionLivePath(channel) : "/";
    const parts: RtspParts = {
      host: device.host,
      port: device.rtspPort,
      username: device.username,
      password: device.passwordEnc ? decryptSecret(device.passwordEnc) : null,
      path,
    };
    return { ...parts, device, trackId: channel ? channel * 100 + 1 : null, liveUrl: buildRtspUrl(parts) };
  }
  const parts: RtspParts = {
    host: camera.host ?? "",
    port: camera.port,
    username: camera.username,
    password: camera.passwordEnc ? decryptSecret(camera.passwordEnc) : null,
    path: camera.rtspPath || "/",
  };
  return { ...parts, device: null, trackId: channel ? channel * 100 + 1 : null, liveUrl: buildRtspUrl(parts) };
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
  const rows = await db.query.devices.findMany();
  for (const d of rows) if (ids.includes(d.id)) map.set(d.id, d);
  return map;
}
