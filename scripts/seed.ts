// Seeds the first administrator, default sites and (optionally) cameras from an
// NVR channel list file, then links every camera to its recorder (NVR/DVR).
// Idempotent: existing rows are left untouched. Usage: npm run db:seed
import fs from "node:fs";
import path from "node:path";
import { and, count, eq, isNull } from "drizzle-orm";
import { db, pool, runMigrations } from "../src/db";
import { auditLogs, cameras, devices, stores, users } from "../src/db/schema";
import { env } from "../src/env";
import { hashPassword } from "../src/lib/auth/password";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";
import { parseCameraList, slugify } from "../src/lib/rtsp";

const DEFAULT_SITES = [
  { code: "HO", name: "Libas Head Office", kind: "STORE" as const, city: "Mumbai", region: "Maharashtra" },
  { code: "CORP", name: "Corporate", kind: "CORPORATE" as const, city: "Mumbai", region: "Maharashtra" },
  { code: "WH", name: "Warehouse", kind: "WAREHOUSE" as const, city: "Mumbai", region: "Maharashtra" },
  { code: "WH2", name: "New Warehouse", kind: "WAREHOUSE" as const, city: "Mumbai", region: "Maharashtra" },
];

function channelOf(rtspPath: string): number | null {
  const m = /channels\/(\d+?)0[12]$/i.exec(rtspPath);
  return m ? Number(m[1]) : null;
}

async function main() {
  await runMigrations();

  // 1. Administrator
  let adminId = "";
  const [userCount] = await db.select({ n: count() }).from(users);
  if (Number(userCount?.n ?? 0) === 0) {
    const [admin] = await db
      .insert(users)
      .values({
        email: env.ADMIN_EMAIL.toLowerCase(),
        name: env.ADMIN_NAME,
        role: "ADMIN",
        passwordHash: await hashPassword(env.ADMIN_PASSWORD),
        mustChangePassword: true,
      })
      .returning({ id: users.id });
    adminId = admin!.id;
    console.log(`Created administrator ${env.ADMIN_EMAIL} (password from ADMIN_PASSWORD; change it at first sign-in).`);
  } else {
    const existing = await db.query.users.findFirst({ where: eq(users.role, "ADMIN") });
    adminId = existing?.id ?? "";
    console.log("Users already exist; administrator not changed.");
  }

  // 2. Default sites (stores + corporate/warehouse locations)
  for (const site of DEFAULT_SITES) {
    const exists = await db.query.stores.findFirst({ where: eq(stores.code, site.code) });
    if (!exists) {
      await db.insert(stores).values({ ...site, timezone: "Asia/Kolkata" });
      console.log(`Created site ${site.code} (${site.name}, ${site.kind}).`);
    }
  }
  const home = (await db.query.stores.findFirst({ where: eq(stores.code, "HO") }))!;

  // 3. Cameras from the NVR list (link.txt by default)
  const file = env.SEED_CAMERA_FILE ? path.resolve(process.cwd(), env.SEED_CAMERA_FILE) : null;
  if (file && fs.existsSync(file)) {
    const { cameras: found, errors } = parseCameraList(fs.readFileSync(file, "utf8"));
    const existing = await db.select({ host: cameras.host, port: cameras.port, rtspPath: cameras.rtspPath, pathName: cameras.pathName }).from(cameras);
    const keys = new Set(existing.map((c) => `${c.host}:${c.port}${c.rtspPath}`));
    const names = new Set(existing.map((c) => c.pathName));
    let created = 0;
    let order = existing.length;
    for (const cam of found) {
      const key = `${cam.parts.host}:${cam.parts.port}${cam.parts.path}`;
      if (keys.has(key)) continue;
      const base = `${slugify(home.code)}-${slugify(cam.name)}`;
      let pathName = base;
      for (let i = 2; names.has(pathName); i++) pathName = `${base}-${i}`;
      names.add(pathName);
      keys.add(key);
      await db.insert(cameras).values({
        storeId: home.id,
        name: cam.name,
        pathName,
        host: cam.parts.host,
        port: cam.parts.port,
        username: cam.parts.username,
        passwordEnc: cam.parts.password ? encryptSecret(cam.parts.password) : null,
        rtspPath: cam.parts.path,
        channel: channelOf(cam.parts.path),
        transport: "tcp",
        playbackMode: "NVR",
        recordEnabled: false,
        retentionDays: env.DEFAULT_RETENTION_DAYS,
        sortOrder: order++,
      });
      created += 1;
    }
    console.log(`Imported ${created} camera(s) from ${path.basename(file)} (${found.length - created} already existed, ${errors.length} unparsable line(s)).`);
    if (created > 0 && adminId) {
      await db.insert(auditLogs).values({ actorId: adminId, actorEmail: "seed", action: "camera.imported", entityType: "store", entityId: home.id, entityLabel: home.name, details: JSON.stringify({ created, source: path.basename(file) }) });
    }
  } else if (file) {
    console.log(`Camera file ${file} not found; skipping camera import.`);
  }

  // 4. Link cameras without a recorder to an NVR device (one per host:port per site)
  const orphans = await db.select().from(cameras).where(isNull(cameras.deviceId));
  let linked = 0;
  for (const cam of orphans) {
    if (!cam.host) continue;
    let device = await db.query.devices.findFirst({ where: and(eq(devices.host, cam.host), eq(devices.rtspPort, cam.port)) });
    if (!device) {
      const [row] = await db
        .insert(devices)
        .values({
          storeId: cam.storeId,
          name: `NVR ${cam.host}`,
          kind: "NVR",
          vendor: "hikvision",
          host: cam.host,
          rtspPort: cam.port,
          httpPort: 80,
          username: cam.username,
          passwordEnc: cam.passwordEnc,
        })
        .returning();
      device = row!;
      console.log(`Created device ${device.name} for site ${cam.storeId}.`);
    } else if (!device.passwordEnc && cam.passwordEnc) {
      await db.update(devices).set({ username: cam.username, passwordEnc: encryptSecret(decryptSecret(cam.passwordEnc)) }).where(eq(devices.id, device.id));
    }
    await db
      .update(cameras)
      .set({ deviceId: device.id, channel: cam.channel ?? channelOf(cam.rtspPath), playbackMode: "NVR" })
      .where(eq(cameras.id, cam.id));
    linked += 1;
  }
  if (linked) console.log(`Linked ${linked} camera(s) to their recorder.`);

  await pool.end();
  console.log("Seed complete.");
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
