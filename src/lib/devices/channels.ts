import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { cameras, devices, stores } from "@/db/schema";
import { getChannels } from "@/lib/hikvision/isapi";
import { hikvisionLivePath } from "@/lib/cameras/source";
import { slugify } from "@/lib/rtsp";
import { isIsapiVendor } from "@/lib/vendors";

export interface ChannelImportResult {
  found: number;
  created: number;
  renamed: number;
  unchanged: number;
  createdIds: string[];
}

/**
 * Reads the channel list from a Hikvision recorder and creates a camera for
 * every channel that is not linked yet (named as on the recorder). With
 * `rename`, existing linked cameras take the recorder's channel name too.
 */
export async function importDeviceChannels(deviceId: string, opts: { rename?: boolean } = {}): Promise<ChannelImportResult> {
  const device = await db.query.devices.findFirst({ where: eq(devices.id, deviceId) });
  if (!device) throw new Error("Recorder not found.");
  if (!isIsapiVendor(device.vendor)) throw new Error("Channel import is only available for Hikvision-compatible recorders.");
  const site = await db.query.stores.findFirst({ where: eq(stores.id, device.storeId) });
  if (!site) throw new Error("Recorder site not found.");

  const channels = await getChannels(device);
  const linked = await db.select().from(cameras).where(eq(cameras.deviceId, deviceId));
  const byChannel = new Map(linked.filter((c) => c.channel != null).map((c) => [c.channel as number, c]));
  const usedPaths = new Set((await db.select({ p: cameras.pathName }).from(cameras)).map((r) => r.p));
  const [{ maxOrder } = { maxOrder: 0 }] = await db
    .select({ maxOrder: sql<number>`coalesce(max(${cameras.sortOrder}), 0)` })
    .from(cameras)
    .where(eq(cameras.storeId, device.storeId));

  const result: ChannelImportResult = { found: channels.length, created: 0, renamed: 0, unchanged: 0, createdIds: [] };
  let order = Number(maxOrder);

  for (const ch of channels.sort((a, b) => a.id - b.id)) {
    const existing = byChannel.get(ch.id);
    if (existing) {
      if (opts.rename && existing.name !== ch.name) {
        await db.update(cameras).set({ name: ch.name }).where(and(eq(cameras.id, existing.id)));
        result.renamed += 1;
      } else {
        result.unchanged += 1;
      }
      continue;
    }
    const base = `${slugify(site.code) || "site"}-${slugify(device.name) || "nvr"}-ch${ch.id}`;
    let pathName = base;
    for (let i = 2; usedPaths.has(pathName); i++) pathName = `${base}-${i}`;
    usedPaths.add(pathName);
    const [row] = await db
      .insert(cameras)
      .values({
        storeId: device.storeId,
        deviceId: device.id,
        channel: ch.id,
        name: ch.name,
        pathName,
        description: ch.ipAddress ? `Camera IP ${ch.ipAddress}` : null,
        rtspPath: hikvisionLivePath(ch.id),
        transport: "tcp",
        playbackMode: "NVR",
        recordEnabled: false,
        isEnabled: true,
        sortOrder: ++order,
      })
      .returning({ id: cameras.id });
    if (row) {
      result.created += 1;
      result.createdIds.push(row.id);
    }
  }

  if (!device.channelCount || device.channelCount < channels.length) {
    await db.update(devices).set({ channelCount: channels.length }).where(eq(devices.id, device.id));
  }
  return result;
}
