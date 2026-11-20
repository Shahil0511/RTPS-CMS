import "server-only";
import type { Device } from "@/db/schema";
import { setDeviceInfoProvider, type DeviceInfo } from "@/lib/devices/health";
import { getChannelCount, getClock, getDeviceInfo, getStorage, rememberDetectedOffset } from "./isapi";

/** How often model/serial/disk facts are re-read from each recorder. */
const INFO_REFRESH_MS = 10 * 60 * 1000;

/**
 * Reads recorder facts over ISAPI for Hikvision devices. Called by the
 * device health check for every ONLINE recorder; throttled per device.
 */
async function hikvisionInfo(device: Device): Promise<DeviceInfo | null> {
  if (device.vendor !== "hikvision" || device.kind === "CAMERA") return null;
  if (device.infoCheckedAt && Date.now() - device.infoCheckedAt.getTime() < INFO_REFRESH_MS) return null;

  const [info, storage, clock, channels] = await Promise.allSettled([
    getDeviceInfo(device),
    getStorage(device),
    getClock(device),
    device.channelCount ? Promise.resolve(device.channelCount) : getChannelCount(device),
  ]);

  // Authentication problems surface as an error so they show up on the health page.
  if (info.status === "rejected" && storage.status === "rejected") {
    throw info.reason instanceof Error ? info.reason : new Error(String(info.reason));
  }

  const out: DeviceInfo = { infoCheckedAt: new Date() };
  if (clock.status === "fulfilled") {
    rememberDetectedOffset(device.id, clock.value.offsetMinutes);
    out.clockDriftSeconds = clock.value.driftSeconds;
  }
  if (info.status === "fulfilled") {
    out.model = info.value.model;
    out.serialNumber = info.value.serialNumber;
    out.firmware = info.value.firmware;
  }
  if (storage.status === "fulfilled") {
    out.storageStatus = storage.value.summary;
    out.storageTotalMb = storage.value.totalMb;
    out.storageFreeMb = storage.value.freeMb;
  }
  if (channels.status === "fulfilled" && channels.value) out.channelCount = channels.value;
  return out;
}

declare global {
  // eslint-disable-next-line no-var
  var __vmsHikProvider: boolean | undefined;
}

export function registerHikvisionProvider(): void {
  if (globalThis.__vmsHikProvider) return;
  globalThis.__vmsHikProvider = true;
  setDeviceInfoProvider(hikvisionInfo);
}
