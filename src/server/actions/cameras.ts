"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { cameras, devices, stores, RTSP_TRANSPORTS, type Camera, type Device } from "@/db/schema";
import { audit } from "@/lib/audit";
import { canAccessCamera, canAccessStore, hasWholeStore, rolesFor, WHOLE_STORE_REQUIRED } from "@/lib/auth/rbac";
import { requestMeta, requireUser, type SessionUser } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/crypto";
import { env } from "@/env";
import { channelFromRtspPath, hikvisionLivePath, resolveSource } from "@/lib/cameras/source";
import { tcpProbe } from "@/lib/health/monitor";
import { mtx } from "@/lib/mediamtx/client";
import { removeCameraPath, syncCamera } from "@/lib/mediamtx/sync";
import { getDeviceInternal } from "@/server/queries/devices";
import { parseCameraList, slugify } from "@/lib/rtsp";
import { checkbox, failure, optionalText, parseForm, success, type ActionState } from "../action-utils";

/**
 * A camera is either a channel of a recorder (deviceId + channel; address and
 * credentials come from the device) or a direct RTSP source (host required).
 */
const cameraSchema = z
  .object({
    storeId: z.string().uuid("Select a store"),
    name: z.string().trim().min(2, "Name is required").max(80),
    description: optionalText(300),
    deviceId: z
      .string()
      .trim()
      .optional()
      .transform((v) => (v ? v : null))
      .pipe(z.string().uuid("Select a recorder").nullable()),
    channel: z
      .union([z.coerce.number().int().min(1, "Channel must be 1-512").max(512, "Channel must be 1-512"), z.literal("")])
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
    host: z
      .string()
      .trim()
      .max(253)
      .regex(/^[A-Za-z0-9.-]*$/, "Host must be an IP address or hostname")
      .optional()
      .default(""),
    port: z.coerce.number().int().min(1).max(65535).default(554),
    username: optionalText(100),
    password: z.string().max(200).optional().default(""),
    rtspPath: z
      .string()
      .trim()
      .max(300)
      .optional()
      .default("")
      .transform((v) => (v === "" || v.startsWith("/") ? v : `/${v}`)),
    transport: z.enum(RTSP_TRANSPORTS).default("tcp"),
    recordEnabled: checkbox,
    retentionDays: z.coerce.number().int().min(0).max(3650).default(7),
    isEnabled: checkbox,
    sortOrder: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.deviceId) {
      if (!v.channel && (!v.rtspPath || v.rtspPath === "/")) {
        ctx.addIssue({ code: "custom", path: ["channel"], message: "Enter the channel number on the recorder" });
      }
    } else if (!v.host) {
      ctx.addIssue({ code: "custom", path: ["host"], message: "Host is required for a direct RTSP source" });
    }
  })
  .transform((v) => ({
    ...v,
    rtspPath: v.rtspPath && v.rtspPath !== "/" ? v.rtspPath : v.deviceId && v.channel ? hikvisionLivePath(v.channel) : "/",
    channel: v.channel ?? (v.deviceId ? channelFromRtspPath(v.rtspPath) : null),
  }));

type CameraInput = z.infer<typeof cameraSchema>;

/** Source columns for an insert/update: recorder channels never carry their own address or credentials. */
function sourceColumns(d: CameraInput, device: Device | null) {
  if (device) {
    return { deviceId: device.id, channel: d.channel, host: null, port: device.rtspPort, username: null, passwordEnc: null, rtspPath: d.rtspPath };
  }
  return { deviceId: null, channel: d.channel, host: d.host, port: d.port, username: d.username, ...(d.password ? { passwordEnc: encryptSecret(d.password) } : {}), rtspPath: d.rtspPath };
}

async function resolveDevice(user: SessionUser, d: CameraInput): Promise<Device | null> {
  if (!d.deviceId) return null;
  const device = await getDeviceInternal(d.deviceId);
  if (!device) throw new Error("Recorder not found.");
  if (!canAccessStore(user, device.storeId)) throw new Error("You do not have access to this recorder.");
  if (device.storeId !== d.storeId) throw new Error("The recorder belongs to a different site. Pick a recorder of the selected site.");
  return device;
}

function revalidate() {
  revalidatePath("/cameras");
  revalidatePath("/devices");
  revalidatePath("/live");
  revalidatePath("/health");
  revalidatePath("/");
}

async function uniquePathName(storeCode: string, name: string, excludeId?: string): Promise<string> {
  const base = `${slugify(storeCode) || "store"}-${slugify(name) || "camera"}`;
  let candidate = base;
  for (let i = 2; i < 1000; i++) {
    const clash = await db.query.cameras.findFirst({ where: eq(cameras.pathName, candidate) });
    if (!clash || clash.id === excludeId) return candidate;
    candidate = `${base}-${i}`;
  }
  throw new Error("Could not allocate a unique stream name");
}

async function assertStoreAccess(user: SessionUser, storeId: string) {
  const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
  if (!store) throw new Error("Store not found.");
  if (!canAccessStore(user, store.id)) throw new Error("You do not have access to this store.");
  return store;
}

async function trySync(camera: Camera): Promise<string | null> {
  try {
    await syncCamera(camera);
    return null;
  } catch (e) {
    return `Saved, but the streaming server could not be updated (${(e as Error).message}). It will retry automatically.`;
  }
}

export async function createCameraAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser(rolesFor("cameras.manage"));
  const parsed = parseForm(cameraSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;
  try {
    const store = await assertStoreAccess(user, d.storeId);
    // A camera-limited user could point a new camera at a channel they were not granted.
    if (!hasWholeStore(user, d.storeId)) return failure(WHOLE_STORE_REQUIRED);
    const device = await resolveDevice(user, d);
    const pathName = await uniquePathName(store.code, d.name);
    const [row] = await db
      .insert(cameras)
      .values({
        storeId: d.storeId,
        name: d.name,
        pathName,
        description: d.description,
        passwordEnc: null,
        ...sourceColumns(d, device),
        transport: d.transport,
        recordEnabled: false,
        retentionDays: d.retentionDays,
        isEnabled: d.isEnabled,
        sortOrder: d.sortOrder,
      })
      .returning();
    if (!row) return failure("Could not create camera.");
    const meta = await requestMeta();
    await audit({ actor: user, action: "camera.created", entityType: "camera", entityId: row.id, entityLabel: row.name, details: { store: store.code, device: device?.name ?? null, channel: row.channel, host: row.host, port: row.port, rtspPath: d.rtspPath, record: d.recordEnabled }, ...meta });
    const warning = await trySync(row);
    revalidate();
    return success(warning ?? "Camera created", { id: row.id });
  } catch (e) {
    return failure((e as Error).message);
  }
}

export async function updateCameraAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser(rolesFor("cameras.manage"));
  const id = String(formData.get("id") ?? "");
  const parsed = parseForm(cameraSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;
  try {
    const current = await db.query.cameras.findFirst({ where: eq(cameras.id, id) });
    if (!current) return failure("Camera not found.");
    if (!canAccessCamera(user, current)) return failure("You do not have access to this camera.");
    const store = await assertStoreAccess(user, d.storeId);
    const device = await resolveDevice(user, d);

    // Camera-limited users may rename/describe/enable a granted camera, but never change what it
    // shows: its location, recorder, channel, path or address. Their saves keep the stored source.
    const limited = !hasWholeStore(user, current.storeId) || !hasWholeStore(user, d.storeId);
    if (limited) {
      const rawPath = String(formData.get("rtspPath") ?? "").trim();
      const sourceChanged =
        d.storeId !== current.storeId ||
        (d.deviceId ?? null) !== (current.deviceId ?? null) ||
        (d.channel ?? null) !== (current.channel ?? null) ||
        (rawPath !== "" && d.rtspPath !== current.rtspPath) ||
        (!d.deviceId && (d.host !== (current.host ?? "") || d.port !== current.port || (d.username ?? null) !== (current.username ?? null) || Boolean(d.password)));
      if (sourceChanged) return failure("Only users with access to every camera at this location can change a camera's location, recorder, channel or address.");
    }

    // A direct camera's stored password must never be sent to a different address.
    if (!limited && !device && current.passwordEnc && !d.password && (current.host !== d.host || current.port !== d.port)) {
      return { ok: false, error: "Re-enter the camera password when changing its address or port.", fieldErrors: { password: ["Required when the address changes"] } };
    }

    const nameChanged = current.name !== d.name || current.storeId !== d.storeId;
    const pathName = nameChanged ? await uniquePathName(store.code, d.name, id) : current.pathName;

    const [row] = await db
      .update(cameras)
      .set({
        storeId: limited ? current.storeId : d.storeId,
        name: d.name,
        pathName,
        description: d.description,
        ...(limited ? {} : sourceColumns(d, device)),
        transport: d.transport,
        recordEnabled: false,
        retentionDays: d.retentionDays,
        isEnabled: d.isEnabled,
        sortOrder: d.sortOrder,
      })
      .where(eq(cameras.id, id))
      .returning();
    if (!row) return failure("Could not update camera.");

    if (pathName !== current.pathName) {
      try {
        await removeCameraPath(current.pathName);
      } catch {
        // reconciliation will clean it up
      }
    }
    const meta = await requestMeta();
    await audit({ actor: user, action: "camera.updated", entityType: "camera", entityId: id, entityLabel: row.name, details: { store: store.code, device: device?.name ?? null, channel: row.channel, host: row.host, port: row.port, rtspPath: d.rtspPath, record: d.recordEnabled, enabled: d.isEnabled, passwordChanged: Boolean(d.password && !device) }, ...meta });
    const warning = await trySync(row);
    revalidate();
    return success(warning ?? "Camera updated");
  } catch (e) {
    return failure((e as Error).message);
  }
}

export async function deleteCameraAction(id: string): Promise<ActionState> {
  const user = await requireUser(rolesFor("cameras.manage"));
  const current = await db.query.cameras.findFirst({ where: eq(cameras.id, id) });
  if (!current) return failure("Camera not found.");
  if (!canAccessCamera(user, current)) return failure("You do not have access to this camera.");
  await db.delete(cameras).where(eq(cameras.id, id));
  try {
    await removeCameraPath(current.pathName);
  } catch {
    // reconciliation will clean it up
  }
  const meta = await requestMeta();
  await audit({ actor: user, action: "camera.deleted", entityType: "camera", entityId: id, entityLabel: current.name, details: { host: current.host, deviceId: current.deviceId, channel: current.channel, pathName: current.pathName }, ...meta });
  revalidate();
  return success("Camera deleted");
}

export async function restartCameraAction(id: string): Promise<ActionState> {
  const user = await requireUser(rolesFor("cameras.manage"));
  const current = await db.query.cameras.findFirst({ where: eq(cameras.id, id) });
  if (!current) return failure("Camera not found.");
  if (!canAccessCamera(user, current)) return failure("You do not have access to this camera.");
  try {
    await mtx.deletePath(current.pathName);
    await syncCamera(current);
  } catch (e) {
    return failure(`Streaming server error: ${(e as Error).message}`);
  }
  const meta = await requestMeta();
  await audit({ actor: user, action: "camera.restarted", entityType: "camera", entityId: id, entityLabel: current.name, ...meta });
  return success("Stream restarted");
}

export interface CameraTestResult extends Record<string, unknown> {
  reachable: boolean;
  latencyMs: number | null;
  error?: string;
  streamOnline: boolean | null;
  tracks: string[];
}

export async function testCameraAction(id: string): Promise<ActionState> {
  const user = await requireUser(rolesFor("cameras.manage"));
  const current = await db.query.cameras.findFirst({ where: eq(cameras.id, id) });
  if (!current) return failure("Camera not found.");
  if (!canAccessCamera(user, current)) return failure("You do not have access to this camera.");
  const source = await resolveSource(current);
  if (!source.host) return failure("This camera has no recorder or host configured.");
  const probe = await tcpProbe(source.host, source.port);
  let streamOnline: boolean | null = null;
  let tracks: string[] = [];
  try {
    const p = await mtx.getPath(current.pathName);
    streamOnline = p?.online ?? false;
    tracks = (p?.tracks2 ?? []).map((t) => t.codec);
  } catch {
    streamOnline = null;
  }
  const data: CameraTestResult = { reachable: probe.ok, latencyMs: probe.latencyMs, error: probe.error, streamOnline, tracks };
  const summary = !probe.ok
    ? `Device unreachable: ${probe.error ?? "no response"}`
    : streamOnline
      ? `Reachable in ${probe.latencyMs} ms, stream online (${tracks.join(", ") || "no tracks yet"})`
      : streamOnline === false
        ? `Reachable in ${probe.latencyMs} ms, but the RTSP stream is not online yet`
        : `Reachable in ${probe.latencyMs} ms (streaming server unavailable)`;
  return { ok: probe.ok, message: summary, data };
}

const importSchema = z.object({
  storeId: z.string().uuid("Select a store"),
  text: z.string().min(10, "Paste at least one rtsp:// URL"),
  recordEnabled: checkbox,
  retentionDays: z.coerce.number().int().min(0).max(3650).default(env.DEFAULT_RETENTION_DAYS),
});

export async function importCamerasAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser(rolesFor("cameras.manage"));
  const parsed = parseForm(importSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;
  try {
    const store = await assertStoreAccess(user, d.storeId);
    if (!hasWholeStore(user, d.storeId)) return failure(WHOLE_STORE_REQUIRED);
    const { cameras: found, errors } = parseCameraList(d.text);
    if (found.length === 0) return failure(`No valid RTSP URLs found. ${errors[0] ?? ""}`.trim());

    // Every host:port in the list is a recorder: find or create it once, then link channels to it.
    const existing = await db.select().from(cameras).where(eq(cameras.storeId, d.storeId));
    // Recorders are matched inside the target store only: store LANs reuse the same private
    // addresses, so the same host:port at another store is a different recorder.
    const allDevices = await db.select().from(devices).where(eq(devices.storeId, d.storeId));
    const deviceByEndpoint = new Map(allDevices.map((dev) => [`${dev.host}:${dev.rtspPort}`, dev]));
    const existingKeys = new Set(
      existing.map((c) => {
        const dev = c.deviceId ? allDevices.find((x) => x.id === c.deviceId) : null;
        return dev ? `${dev.host}:${dev.rtspPort}${c.rtspPath}` : `${c.host}:${c.port}${c.rtspPath}`;
      }),
    );
    const created: Camera[] = [];
    const createdDevices: string[] = [];
    let skipped = 0;
    let order = existing.length;
    const meta = await requestMeta();
    for (const item of found) {
      const key = `${item.parts.host}:${item.parts.port}${item.parts.path}`;
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }
      const endpoint = `${item.parts.host}:${item.parts.port}`;
      let device = deviceByEndpoint.get(endpoint) ?? null;
      if (!device) {
        const [dev] = await db
          .insert(devices)
          .values({
            storeId: d.storeId,
            name: `NVR ${item.parts.host}`,
            kind: "NVR",
            vendor: "hikvision",
            host: item.parts.host,
            rtspPort: item.parts.port,
            username: item.parts.username,
            passwordEnc: item.parts.password ? encryptSecret(item.parts.password) : null,
          })
          .returning();
        if (!dev) throw new Error(`Could not create recorder for ${endpoint}`);
        device = dev;
        deviceByEndpoint.set(endpoint, dev);
        createdDevices.push(dev.name);
        await audit({ actor: user, action: "device.created", entityType: "device", entityId: dev.id, entityLabel: dev.name, details: { store: store.code, host: dev.host, rtspPort: dev.rtspPort, source: "import" }, ...meta });
      }
      const pathName = await uniquePathName(store.code, item.name);
      const [row] = await db
        .insert(cameras)
        .values({
          storeId: d.storeId,
          name: item.name,
          pathName,
          deviceId: device.id,
          channel: channelFromRtspPath(item.parts.path),
          host: null,
          port: device.rtspPort,
          username: null,
          passwordEnc: null,
          rtspPath: item.parts.path,
          transport: "tcp",
          recordEnabled: false,
          retentionDays: d.retentionDays,
          isEnabled: true,
          sortOrder: order++,
        })
        .returning();
      if (row) {
        created.push(row);
        existingKeys.add(key);
      }
    }
    await audit({ actor: user, action: "camera.imported", entityType: "store", entityId: store.id, entityLabel: store.name, details: { created: created.length, skipped, parseErrors: errors.length, recordersCreated: createdDevices }, ...meta });
    let syncErrors = 0;
    for (const cam of created) {
      if (await trySync(cam)) syncErrors += 1;
    }
    revalidate();
    const parts = [`${created.length} camera(s) imported`];
    if (createdDevices.length) parts.push(`${createdDevices.length} recorder(s) created`);
    if (skipped) parts.push(`${skipped} duplicate(s) skipped`);
    if (errors.length) parts.push(`${errors.length} line(s) could not be parsed`);
    if (syncErrors) parts.push(`streaming server offline: paths will be registered automatically`);
    return success(parts.join(", "), { created: created.length });
  } catch (e) {
    return failure((e as Error).message);
  }
}

export async function toggleCameraEnabledAction(id: string, enabled: boolean): Promise<ActionState> {
  const user = await requireUser(rolesFor("cameras.manage"));
  const current = await db.query.cameras.findFirst({ where: and(eq(cameras.id, id)) });
  if (!current) return failure("Camera not found.");
  if (!canAccessCamera(user, current)) return failure("You do not have access to this camera.");
  const [row] = await db.update(cameras).set({ isEnabled: enabled }).where(eq(cameras.id, id)).returning();
  const meta = await requestMeta();
  await audit({ actor: user, action: "camera.updated", entityType: "camera", entityId: id, entityLabel: current.name, details: { enabled }, ...meta });
  if (row) await trySync(row);
  revalidate();
  return success(enabled ? "Camera enabled" : "Camera disabled");
}
