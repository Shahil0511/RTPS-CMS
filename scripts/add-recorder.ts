// Registers (or updates) a recorder and optionally imports its channels as cameras.
//
//   set RECORDER_PASSWORD=...   (PowerShell: $env:RECORDER_PASSWORD="...")
//   npm run recorder:add -- --site WH --name "NVR 4" --host 172.16.1.4 --user admin --import
//
// Flags: --site <code> (required) --name <text> --host <ip> (required) --user <name>
//        --kind NVR|DVR --http-port 80 --rtsp-port 554 --import --rename
// The password is read from RECORDER_PASSWORD so it never appears in shell history or output.
import { and, eq } from "drizzle-orm";
import { db, pool, runMigrations } from "../src/db";
import { cameras, devices, stores } from "../src/db/schema";
import { encryptSecret } from "../src/lib/crypto";
import { importDeviceChannels } from "../src/lib/devices/channels";
import { getChannelCount, getClock, getDeviceInfo, getStorage, rememberDetectedOffset } from "../src/lib/hikvision/isapi";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}

async function main() {
  await runMigrations();
  const siteCode = arg("site")?.toUpperCase();
  const host = arg("host");
  if (!siteCode || !host) throw new Error("Usage: --site <code> --host <ip> [--name ...] [--user admin] [--import] [--rename]");
  const site = await db.query.stores.findFirst({ where: eq(stores.code, siteCode) });
  if (!site) throw new Error(`Site ${siteCode} not found. Create it on the Stores page first.`);

  const rtspPort = Number(arg("rtsp-port") ?? 554);
  const httpPort = Number(arg("http-port") ?? 80);
  const password = process.env.RECORDER_PASSWORD ?? "";
  const kind = (arg("kind")?.toUpperCase() ?? "NVR") as "NVR" | "DVR";
  const name = arg("name") ?? `${kind} ${host}`;
  const user = arg("user") ?? "admin";

  const existing = await db.query.devices.findFirst({ where: and(eq(devices.host, host), eq(devices.rtspPort, rtspPort)) });
  const values = {
    storeId: site.id,
    name,
    kind,
    vendor: "hikvision",
    host,
    rtspPort,
    httpPort,
    username: user,
    ...(password ? { passwordEnc: encryptSecret(password) } : {}),
  };
  let deviceId: string;
  if (existing) {
    await db.update(devices).set(values).where(eq(devices.id, existing.id));
    // Linked cameras follow their recorder to the new site.
    await db.update(cameras).set({ storeId: site.id }).where(eq(cameras.deviceId, existing.id));
    deviceId = existing.id;
    console.log(`Updated recorder "${name}" (${host}) at site ${site.code}.`);
  } else {
    const [row] = await db.insert(devices).values(values).returning({ id: devices.id });
    deviceId = row!.id;
    console.log(`Created recorder "${name}" (${host}) at site ${site.code}.`);
  }

  const device = (await db.query.devices.findFirst({ where: eq(devices.id, deviceId) }))!;
  try {
    const [info, clock, channels, storage] = await Promise.all([getDeviceInfo(device), getClock(device), getChannelCount(device), getStorage(device)]);
    rememberDetectedOffset(device.id, clock.offsetMinutes);
    await db
      .update(devices)
      .set({ model: info.model, serialNumber: info.serialNumber, firmware: info.firmware, channelCount: channels, clockDriftSeconds: clock.driftSeconds, storageStatus: storage.summary, storageTotalMb: storage.totalMb, storageFreeMb: storage.freeMb, infoCheckedAt: new Date() })
      .where(eq(devices.id, deviceId));
    const drift = clock.driftSeconds ?? 0;
    console.log(`  Disks: ${storage.summary}.`);
    console.log(`  Login OK: ${info.model ?? "?"} firmware ${info.firmware ?? "?"}, ${channels ?? "?"} channels.`);
    console.log(`  Clock: ${clock.ntp ? "NTP" : "manual"}, ${Math.abs(drift) < 30 ? "in sync" : `${Math.round(Math.abs(drift) / 60)} min ${drift > 0 ? "fast" : "slow"} (corrected automatically)`}.`);
  } catch (e) {
    console.log(`  Could not read recorder details: ${(e as Error).message}`);
  }

  if (arg("import")) {
    const r = await importDeviceChannels(deviceId, { rename: Boolean(arg("rename")) });
    console.log(`  Channels: ${r.found} found, ${r.created} added, ${r.renamed} renamed, ${r.unchanged} already linked.`);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error((err as Error).message);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
