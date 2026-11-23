import "server-only";
import type { Device } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { playbackRtspUrl as isapiPlaybackRtspUrl, toDeviceTime, type DeviceClock } from "@/lib/hikvision/isapi";
import { buildRtspUrl } from "@/lib/rtsp";
import { isConnectable, protocolFamilyOf, VENDORS, vendorOf, type CapabilityLevel, type ProtocolFamily, type VendorId } from "./index";
import { buildLiveRtspUrlPath, dahuaPlaybackPath, formatDahuaTime } from "./rtsp-paths";

/**
 * Server-side vendor adapters. One adapter per protocol family; the brand only
 * changes labels and capability levels. Nothing here logs in to a recorder or
 * retries anything: ISAPI calls (and their 30-minute auth back-off) stay in
 * lib/hikvision/isapi.ts.
 */
export interface VendorAdapter {
  vendor: VendorId;
  family: ProtocolFamily;
  label: string;
  capabilities: { live: CapabilityLevel; playback: CapabilityLevel; download: CapabilityLevel; health: CapabilityLevel };
  /** Hikvision ISAPI channel import / recording search / clip download / disk + clock health. */
  isapi: boolean;
  /** Recorder playback over RTSP is implemented for this family (search may still be unavailable). */
  rtspPlayback: boolean;
  liveRtspPath(channel: number, subStream?: boolean): string;
}

export function adapterFor(device: Pick<Device, "vendor" | "notes">): VendorAdapter {
  const vendor = vendorOf(device.vendor);
  const info = VENDORS[vendor];
  const family = protocolFamilyOf(device.vendor);
  return {
    vendor,
    family,
    label: info.label,
    capabilities: { live: info.live, playback: info.playback, download: info.download, health: info.health },
    isapi: family === "isapi",
    rtspPlayback: family === "isapi" || family === "dahua",
    liveRtspPath: (channel, subStream = false) => buildLiveRtspUrlPath(device, channel, subStream),
  };
}

/**
 * RTSP playback URL (credentials included; server-side only, never send to a client)
 * of a recorder channel between two real instants. Returns null when the vendor
 * family has no RTSP playback or the recorder is not connectable.
 *
 *  isapi -> existing isapi.playbackRtspUrl (/Streaming/tracks/<ch>01?starttime=...&endtime=...)
 *  dahua -> /cam/playback?channel=<n>&starttime=YYYY_MM_DD_HH_mm_ss&endtime=... (UNVERIFIED on CP Plus)
 *
 * `clock` comes from isapi.deviceClock(device, siteTimeZone); its offset/drift
 * handling applies to every family because the recorder indexes footage by its own clock.
 */
export function playbackRtspUrlFor(device: Device, channel: number, from: Date, to: Date, clock: DeviceClock): string | null {
  if (!isConnectable(device)) return null;
  const family = protocolFamilyOf(device.vendor);
  if (family === "isapi") return isapiPlaybackRtspUrl(device, channel * 100 + 1, from, to, clock);
  if (family === "dahua") {
    const start = formatDahuaTime(wallClock(from, clock));
    const end = formatDahuaTime(wallClock(to, clock));
    return buildRtspUrl({
      host: device.host,
      port: device.rtspPort,
      username: device.username,
      password: device.passwordEnc ? decryptSecret(device.passwordEnc) : null,
      path: dahuaPlaybackPath(channel, start, end),
    });
  }
  return null;
}

/** Real instant -> recorder wall clock as a Date read through UTC getters (reuses the ISAPI clock maths). */
function wallClock(date: Date, clock: DeviceClock): Date {
  return new Date(toDeviceTime(date, clock, "dashed"));
}
