"use server";

import { and, count, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { cameras, devices, DEVICE_KINDS, stores } from "@/db/schema";
import { audit } from "@/lib/audit";
import { canAccessStore, rolesFor } from "@/lib/auth/rbac";
import { requestMeta, requireUser, type SessionUser } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/crypto";
import { tcpProbe } from "@/lib/health/monitor";
import { importDeviceChannels } from "@/lib/devices/channels";
import { syncCamera, syncDeviceCameras } from "@/lib/mediamtx/sync";
import { checkbox, failure, optionalText, parseForm, success, type ActionState } from "../action-utils";

export const DEVICE_VENDORS = ["hikvision", "generic"] as const;
export type DeviceVendor = (typeof DEVICE_VENDORS)[number];

const port = (fallback: number) =>
  z
    .union([z.coerce.number().int().min(1, "Port must be 1-65535").max(65535, "Port must be 1-65535"), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? fallback : v));

const deviceSchema = z.object({
  storeId: z.string().uuid("Select a site"),
  name: z.string().trim().min(2, "Name is required").max(80),
  kind: z.enum(DEVICE_KINDS).default("NVR"),
  vendor: z.enum(DEVICE_VENDORS).default("hikvision"),
  host: z
    .string()
    .trim()
    .min(1, "Host is required")
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$/, "Host must be an IP address or hostname"),
  rtspPort: port(554),
  httpPort: port(80),
  httpsEnabled: checkbox,
  username: optionalText(100),
  password: z.string().max(200).optional().default(""),
  channelCount: z
    .union([z.coerce.number().int().min(1, "Channels must be 1-512").max(512, "Channels must be 1-512"), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  notes: optionalText(1000),
  isEnabled: checkbox,
  timeMode: z.enum(["local", "utc"]).default("local"),
  utcOffsetMinutes: z
    .union([z.coerce.number().int().min(-720, "Offset must be between -720 and 840").max(840, "Offset must be between -720 and 840"), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
});

function revalidate() {
  revalidatePath("/devices");
  revalidatePath("/cameras");
  revalidatePath("/health");
  revalidatePath("/");
}

async function assertStoreAccess(user: SessionUser, storeId: string) {
  const store = await db.query.stores.findFirst({ where: eq(stores.id, storeId) });
  if (!store) throw new Error("Site not found.");
  if (!canAccessStore(user, store.id)) throw new Error("You do not have access to this site.");
  return store;
}

/** The (host, rtspPort) pair is unique: two recorders cannot share an RTSP endpoint. */
async function assertEndpointFree(host: string, rtspPort: number, excludeId?: string): Promise<void> {
  const clash = await db.query.devices.findFirst({
    where: excludeId ? and(eq(devices.host, host), eq(devices.rtspPort, rtspPort), ne(devices.id, excludeId)) : and(eq(devices.host, host), eq(devices.rtspPort, rtspPort)),
  });
  if (clash) throw new Error(`Another recorder (${clash.name}) already uses ${host}:${rtspPort}.`);
}

async function trySync(deviceId: string): Promise<string | null> {
  try {
    await syncDeviceCameras(deviceId);
    return null;
  } catch (e) {
    return `Saved, but the streaming server could not be updated (${(e as Error).message}). It will retry automatically.`;
  }
}

export async function createDeviceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const parsed = parseForm(deviceSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;
  try {
    const store = await assertStoreAccess(user, d.storeId);
    await assertEndpointFree(d.host, d.rtspPort);
    const [row] = await db
      .insert(devices)
      .values({
        storeId: d.storeId,
        name: d.name,
        kind: d.kind,
        vendor: d.vendor,
        host: d.host,
        rtspPort: d.rtspPort,
        httpPort: d.httpPort,
        httpsEnabled: d.httpsEnabled,
        username: d.username,
        passwordEnc: d.password ? encryptSecret(d.password) : null,
        channelCount: d.channelCount,
        timeMode: d.timeMode,
        utcOffsetMinutes: d.utcOffsetMinutes,
        notes: d.notes,
        isEnabled: d.isEnabled,
      })
      .returning();
    if (!row) return failure("Could not create recorder.");
    const meta = await requestMeta();
    await audit({
      actor: user,
      action: "device.created",
      entityType: "device",
      entityId: row.id,
      entityLabel: row.name,
      details: { store: store.code, kind: d.kind, vendor: d.vendor, host: d.host, rtspPort: d.rtspPort, httpPort: d.httpPort, channelCount: d.channelCount },
      ...meta,
    });
    const warning = await trySync(row.id);
    revalidate();
    return success(warning ?? "Recorder created", { id: row.id });
  } catch (e) {
    return failure((e as Error).message);
  }
}

export async function updateDeviceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const id = String(formData.get("id") ?? "");
  const parsed = parseForm(deviceSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;
  try {
    const current = await db.query.devices.findFirst({ where: eq(devices.id, id) });
    if (!current) return failure("Recorder not found.");
    if (!canAccessStore(user, current.storeId)) return failure("You do not have access to this recorder.");
    const store = await assertStoreAccess(user, d.storeId);
    await assertEndpointFree(d.host, d.rtspPort, id);

    // The stored password must never be sent to an address other than the one it was saved for.
    const endpointChanged = current.host !== d.host || current.httpPort !== d.httpPort || current.rtspPort !== d.rtspPort || current.httpsEnabled !== d.httpsEnabled;
    if (endpointChanged && current.passwordEnc && !d.password) {
      return { ok: false, error: "Re-enter the recorder password when changing its address or ports.", fieldErrors: { password: ["Required when the address changes"] } };
    }

    const [row] = await db
      .update(devices)
      .set({
        storeId: d.storeId,
        name: d.name,
        kind: d.kind,
        vendor: d.vendor,
        host: d.host,
        rtspPort: d.rtspPort,
        httpPort: d.httpPort,
        httpsEnabled: d.httpsEnabled,
        username: d.username,
        ...(d.password ? { passwordEnc: encryptSecret(d.password) } : {}),
        channelCount: d.channelCount,
        timeMode: d.timeMode,
        utcOffsetMinutes: d.utcOffsetMinutes,
        notes: d.notes,
        isEnabled: d.isEnabled,
      })
      .where(eq(devices.id, id))
      .returning();
    if (!row) return failure("Could not update recorder.");

    // Channels follow their recorder's site so store-scoped access stays consistent.
    if (current.storeId !== d.storeId) {
      await db.update(cameras).set({ storeId: d.storeId }).where(eq(cameras.deviceId, id));
    }

    const meta = await requestMeta();
    await audit({
      actor: user,
      action: "device.updated",
      entityType: "device",
      entityId: id,
      entityLabel: row.name,
      details: { store: store.code, kind: d.kind, vendor: d.vendor, host: d.host, rtspPort: d.rtspPort, httpPort: d.httpPort, enabled: d.isEnabled, channelCount: d.channelCount, passwordChanged: Boolean(d.password) },
      ...meta,
    });
    const warning = await trySync(id);
    revalidate();
    return success(warning ?? "Recorder updated");
  } catch (e) {
    return failure((e as Error).message);
  }
}

/**
 * Deletes a recorder. Refuses while cameras are linked unless the form carries
 * `unlinkCameras=on`, in which case the cameras are kept as orphans (no source)
 * and the recorder is removed.
 */
export async function deleteDeviceAction(id: string, formData?: FormData): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const current = await db.query.devices.findFirst({ where: eq(devices.id, id) });
  if (!current) return failure("Recorder not found.");
  if (!canAccessStore(user, current.storeId)) return failure("You do not have access to this recorder.");

  const unlink = checkbox.parse(formData?.get("unlinkCameras") ?? undefined);
  const [c] = await db.select({ n: count() }).from(cameras).where(eq(cameras.deviceId, id));
  const linked = c?.n ?? 0;
  if (linked > 0 && !unlink) return failure(`Cannot delete: ${linked} camera(s) are still linked to this recorder. Tick "Unlink cameras" to detach them first.`);

  const linkedCameras = linked > 0 ? await db.select().from(cameras).where(eq(cameras.deviceId, id)) : [];
  if (linked > 0) await db.update(cameras).set({ deviceId: null }).where(eq(cameras.deviceId, id));
  await db.delete(devices).where(eq(devices.id, id));

  const meta = await requestMeta();
  await audit({
    actor: user,
    action: "device.deleted",
    entityType: "device",
    entityId: id,
    entityLabel: current.name,
    details: { host: current.host, rtspPort: current.rtspPort, unlinkedCameras: linked },
    ...meta,
  });
  // Unlinked channels have no source any more; drop their stream paths.
  for (const cam of linkedCameras) {
    try {
      await syncCamera({ ...cam, deviceId: null });
    } catch {
      // reconciliation will clean it up
    }
  }
  revalidate();
  return success(linked > 0 ? `Recorder deleted, ${linked} camera(s) unlinked` : "Recorder deleted");
}

export interface DeviceTestResult extends Record<string, unknown> {
  reachable: boolean;
  rtsp: { ok: boolean; latencyMs: number | null; error?: string };
  http: { ok: boolean; latencyMs: number | null; error?: string };
  latencyMs: number | null;
}

/** TCP probe of the recorder's RTSP and HTTP ports. */
export async function testDeviceAction(id: string): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const current = await db.query.devices.findFirst({ where: eq(devices.id, id) });
  if (!current) return failure("Recorder not found.");
  if (!canAccessStore(user, current.storeId)) return failure("You do not have access to this recorder.");

  const [rtsp, http] = await Promise.all([tcpProbe(current.host, current.rtspPort), tcpProbe(current.host, current.httpPort)]);
  const reachable = rtsp.ok || http.ok;
  const latencies = [rtsp.latencyMs, http.latencyMs].filter((v): v is number => v !== null);
  const latencyMs = latencies.length ? Math.min(...latencies) : null;
  const data: DeviceTestResult = { reachable, rtsp, http, latencyMs };

  const answered = [rtsp.ok ? `RTSP ${current.rtspPort}` : null, http.ok ? `HTTP ${current.httpPort}` : null].filter(Boolean).join(", ");
  const silent = [!rtsp.ok ? `RTSP ${current.rtspPort} (${rtsp.error ?? "no response"})` : null, !http.ok ? `HTTP ${current.httpPort} (${http.error ?? "no response"})` : null]
    .filter(Boolean)
    .join(", ");
  const summary = !reachable
    ? `Recorder unreachable on ${current.host}: ${silent}`
    : rtsp.ok && http.ok
      ? `Reachable in ${latencyMs} ms: ${answered} answered`
      : `Partially reachable in ${latencyMs} ms: ${answered} answered, ${silent} did not`;

  await db
    .update(devices)
    .set({
      status: rtsp.ok ? "ONLINE" : "OFFLINE",
      lastCheckedAt: new Date(),
      lastOnlineAt: rtsp.ok ? new Date() : current.lastOnlineAt,
      lastError: rtsp.ok ? null : summary,
      lastLatencyMs: latencyMs,
    })
    .where(eq(devices.id, id));

  const meta = await requestMeta();
  await audit({ actor: user, action: "device.tested", entityType: "device", entityId: id, entityLabel: current.name, details: { host: current.host, rtspOk: rtsp.ok, httpOk: http.ok, latencyMs }, ...meta });
  revalidate();
  return { ok: reachable, message: summary, error: reachable ? undefined : summary, data };
}

export async function toggleDeviceEnabledAction(id: string, enabled: boolean): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const current = await db.query.devices.findFirst({ where: eq(devices.id, id) });
  if (!current) return failure("Recorder not found.");
  if (!canAccessStore(user, current.storeId)) return failure("You do not have access to this recorder.");
  await db.update(devices).set({ isEnabled: enabled }).where(eq(devices.id, id));
  const meta = await requestMeta();
  await audit({ actor: user, action: "device.updated", entityType: "device", entityId: id, entityLabel: current.name, details: { enabled }, ...meta });
  const warning = await trySync(id);
  revalidate();
  return success(warning ?? (enabled ? "Recorder enabled" : "Recorder disabled"));
}

/** Creates cameras for every recorder channel that is not linked yet (names taken from the recorder). */
export async function importDeviceChannelsAction(id: string, rename = false): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const device = await db.query.devices.findFirst({ where: eq(devices.id, id) });
  if (!device) return failure("Recorder not found.");
  if (!canAccessStore(user, device.storeId)) return failure("You do not have access to this recorder.");
  try {
    const r = await importDeviceChannels(id, { rename });
    const meta = await requestMeta();
    await audit({ actor: user, action: "camera.imported", entityType: "device", entityId: id, entityLabel: device.name, details: { source: "recorder", found: r.found, created: r.created, renamed: r.renamed }, ...meta });
    let syncWarning = "";
    try {
      await syncDeviceCameras(id);
    } catch {
      syncWarning = " Streaming server offline: streams register automatically.";
    }
    revalidate();
    return success(`${r.found} channels on recorder: ${r.created} added, ${r.renamed} renamed, ${r.unchanged} already linked.${syncWarning}`, { created: r.created });
  } catch (e) {
    return failure((e as Error).message);
  }
}
