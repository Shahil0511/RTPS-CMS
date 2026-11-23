"use server";

import { and, count, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { cameras, CONNECTION_MODES, devices, DEVICE_KINDS, stores, type ConnectionMode } from "@/db/schema";
import { audit } from "@/lib/audit";
import { canAccessStore, hasWholeStore, rolesFor, WHOLE_STORE_REQUIRED } from "@/lib/auth/rbac";
import { requestMeta, requireUser, type SessionUser } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/crypto";
import { tcpProbe } from "@/lib/health/monitor";
import { importDeviceChannels } from "@/lib/devices/channels";
import { syncCamera, syncDeviceCameras } from "@/lib/mediamtx/sync";
import { CONNECTION_MODE_LABELS, DEVICE_VENDOR_VALUES, hostOptionalFor, isConnectable, protocolFamilyOf, validateRtspTemplate, withRtspTemplate } from "@/lib/vendors";
import { checkbox, failure, optionalText, parseForm, success, type ActionState } from "../action-utils";

// Vendor values live in lib/vendors (DEVICE_VENDOR_VALUES): a "use server" file may only export async functions.

const port = (fallback: number) =>
  z
    .union([z.coerce.number().int().min(1, "Port must be 1-65535").max(65535, "Port must be 1-65535"), z.literal("")])
    .optional()
    .transform((v) => (v === "" || v === undefined ? fallback : v));

const deviceSchema = z
  .object({
    storeId: z.string().uuid("Select a site"),
    name: z.string().trim().min(2, "Name is required").max(80),
    kind: z.enum(DEVICE_KINDS).default("NVR"),
    vendor: z.enum(DEVICE_VENDOR_VALUES, { message: "Select a vendor" }).default("hikvision"),
    /** "" = keep the current mode (edit form opened without one) or DIRECT on create. */
    connectionMode: z.union([z.enum(CONNECTION_MODES), z.literal("")]).optional().default(""),
    host: z
      .string()
      .trim()
      .max(253)
      .optional()
      .default("")
      .refine((v) => v === "" || /^[A-Za-z0-9.-]+$/.test(v), "Host must be an IP address or hostname"),
    rtspPort: port(554),
    httpPort: port(80),
    httpsEnabled: checkbox,
    username: optionalText(100),
    password: z.string().max(200).optional().default(""),
    /** Present when the form rendered the cloud fields; otherwise the stored values are kept. */
    cloudFields: z.string().optional(),
    cloudPlatform: optionalText(60),
    /** Login identifier or device serial on the vendor cloud. Never a password. */
    cloudAccount: optionalText(120),
    rtspTemplate: z
      .string()
      .trim()
      .max(300)
      .optional()
      .default("")
      .superRefine((v, ctx) => {
        const error = validateRtspTemplate(v);
        if (error) ctx.addIssue({ code: "custom", message: error });
      }),
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
  })
  .superRefine((d, ctx) => {
    // Pending-network and cloud-only recorders may not have a known address yet.
    if (!d.host && d.connectionMode !== "" && !hostOptionalFor(d.connectionMode)) {
      ctx.addIssue({ code: "custom", path: ["host"], message: "Host is required for a live recorder (or choose Pending network / Cloud-only)" });
    }
  });

type DeviceInput = z.infer<typeof deviceSchema>;

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
  // Recorders carry every channel of the site: only users who see the whole site may change them.
  if (!hasWholeStore(user, store.id)) throw new Error(WHOLE_STORE_REQUIRED);
  return store;
}

/** Access check for changing an existing recorder: the store and every camera in it. */
function wholeStoreError(user: SessionUser, storeId: string): string | null {
  if (!canAccessStore(user, storeId)) return "You do not have access to this recorder.";
  if (!hasWholeStore(user, storeId)) return WHOLE_STORE_REQUIRED;
  return null;
}

/**
 * (store, host, rtspPort) is unique: store LANs reuse 192.168.1.x, so the same
 * address may exist once per store. Recorders without an address (host "") also
 * count, because the database index treats "" like any other value.
 */
async function assertEndpointFree(storeId: string, host: string, rtspPort: number, excludeId?: string): Promise<void> {
  const same = and(eq(devices.storeId, storeId), eq(devices.host, host), eq(devices.rtspPort, rtspPort));
  const clash = await db.query.devices.findFirst({ where: excludeId ? and(same, ne(devices.id, excludeId)) : same });
  if (!clash) return;
  if (!host) throw new Error(`Another recorder at this site (${clash.name}) has no address yet on RTSP port ${rtspPort}. Give one of them its address, or use a different RTSP port.`);
  throw new Error(`Another recorder at this site (${clash.name}) already uses ${host}:${rtspPort}.`);
}

/** Notes plus the RTSP template marker line, which only template-family vendors use. */
function notesFor(d: DeviceInput): string | null {
  const template = protocolFamilyOf(d.vendor) === "template" ? d.rtspTemplate : "";
  return withRtspTemplate(d.notes, template);
}

function modeLabel(mode: string): string {
  return CONNECTION_MODE_LABELS[mode as ConnectionMode]?.label ?? mode;
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
    const connectionMode: ConnectionMode = d.connectionMode || "DIRECT";
    if (!d.host && !hostOptionalFor(connectionMode)) {
      return { ok: false, error: "Host is required for a live recorder.", fieldErrors: { host: ["Required for Live / Live (relay)"] } };
    }
    await assertEndpointFree(d.storeId, d.host, d.rtspPort);
    const [row] = await db
      .insert(devices)
      .values({
        storeId: d.storeId,
        name: d.name,
        kind: d.kind,
        vendor: d.vendor,
        connectionMode,
        cloudPlatform: d.cloudPlatform,
        cloudAccount: d.cloudAccount,
        host: d.host,
        rtspPort: d.rtspPort,
        httpPort: d.httpPort,
        httpsEnabled: d.httpsEnabled,
        username: d.username,
        passwordEnc: d.password ? encryptSecret(d.password) : null,
        channelCount: d.channelCount,
        timeMode: d.timeMode,
        utcOffsetMinutes: d.utcOffsetMinutes,
        notes: notesFor(d),
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
      details: { store: store.code, kind: d.kind, vendor: d.vendor, connectionMode, cloudPlatform: d.cloudPlatform, host: d.host, rtspPort: d.rtspPort, httpPort: d.httpPort, channelCount: d.channelCount },
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
    const denied = wholeStoreError(user, current.storeId);
    if (denied) return failure(denied);
    const store = await assertStoreAccess(user, d.storeId);
    const connectionMode: ConnectionMode = d.connectionMode || current.connectionMode;
    if (!d.host && !hostOptionalFor(connectionMode)) {
      return { ok: false, error: "Host is required for a live recorder.", fieldErrors: { host: ["Required for Live / Live (relay)"] } };
    }
    await assertEndpointFree(d.storeId, d.host, d.rtspPort, id);

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
        connectionMode,
        ...(d.cloudFields ? { cloudPlatform: d.cloudPlatform, cloudAccount: d.cloudAccount } : {}),
        host: d.host,
        rtspPort: d.rtspPort,
        httpPort: d.httpPort,
        httpsEnabled: d.httpsEnabled,
        username: d.username,
        ...(d.password ? { passwordEnc: encryptSecret(d.password) } : {}),
        channelCount: d.channelCount,
        timeMode: d.timeMode,
        utcOffsetMinutes: d.utcOffsetMinutes,
        notes: notesFor(d),
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
      details: {
        store: store.code,
        kind: d.kind,
        vendor: d.vendor,
        connectionMode,
        ...(connectionMode !== current.connectionMode ? { previousConnectionMode: current.connectionMode } : {}),
        host: d.host,
        rtspPort: d.rtspPort,
        httpPort: d.httpPort,
        enabled: d.isEnabled,
        channelCount: d.channelCount,
        passwordChanged: Boolean(d.password),
      },
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
  const denied = wholeStoreError(user, current.storeId);
  if (denied) return failure(denied);

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
    details: { host: current.host, rtspPort: current.rtspPort, connectionMode: current.connectionMode, unlinkedCameras: linked },
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

/**
 * TCP probe of the recorder's RTSP and HTTP ports (no login). Pending-network and
 * cloud-only recorders can be probed by hand, but the result does not change their
 * status: they are not monitored, so a failed test can never raise an alert.
 */
export async function testDeviceAction(id: string): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const current = await db.query.devices.findFirst({ where: eq(devices.id, id) });
  if (!current) return failure("Recorder not found.");
  if (!canAccessStore(user, current.storeId)) return failure("You do not have access to this recorder.");
  if (!current.host) return failure(`This recorder has no address yet (${modeLabel(current.connectionMode)}). Add its IP or hostname first.`);
  const monitored = isConnectable(current);

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

  if (monitored) {
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
  }

  const meta = await requestMeta();
  await audit({
    actor: user,
    action: "device.tested",
    entityType: "device",
    entityId: id,
    entityLabel: current.name,
    details: { host: current.host, connectionMode: current.connectionMode, rtspOk: rtsp.ok, httpOk: http.ok, latencyMs },
    ...meta,
  });
  revalidate();
  const message =
    !monitored && reachable
      ? `${summary}. Something answers at this address, but a private store IP can also answer from another LAN (another store, or the server's own network). Confirm it is the right recorder (for example by its model and serial on the recorder's web page) before switching its connection to "Live".`
      : summary;
  return { ok: reachable, message, error: reachable ? undefined : message, data };
}

/** Changes only how the server reaches a recorder (e.g. Pending network -> Live once a route exists). */
export async function setDeviceConnectionModeAction(id: string, mode: ConnectionMode): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const parsedMode = z.enum(CONNECTION_MODES).safeParse(mode);
  if (!parsedMode.success) return failure("Unknown connection mode.");
  const current = await db.query.devices.findFirst({ where: eq(devices.id, id) });
  if (!current) return failure("Recorder not found.");
  const denied = wholeStoreError(user, current.storeId);
  if (denied) return failure(denied);
  if (!current.host && !hostOptionalFor(parsedMode.data)) return failure("Add the recorder address before switching it to Live.");
  if (current.connectionMode === parsedMode.data) return success("Connection unchanged");
  await db.update(devices).set({ connectionMode: parsedMode.data }).where(eq(devices.id, id));
  const meta = await requestMeta();
  await audit({
    actor: user,
    action: "device.updated",
    entityType: "device",
    entityId: id,
    entityLabel: current.name,
    details: { connectionMode: parsedMode.data, previousConnectionMode: current.connectionMode },
    ...meta,
  });
  const warning = await trySync(id);
  revalidate();
  return success(warning ?? `Connection set to ${modeLabel(parsedMode.data)}`);
}

export async function toggleDeviceEnabledAction(id: string, enabled: boolean): Promise<ActionState> {
  const user = await requireUser(rolesFor("devices.manage"));
  const current = await db.query.devices.findFirst({ where: eq(devices.id, id) });
  if (!current) return failure("Recorder not found.");
  const denied = wholeStoreError(user, current.storeId);
  if (denied) return failure(denied);
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
  // Renaming rewrites camera names from the recorder, including cameras the user was not granted.
  if (rename && !hasWholeStore(user, device.storeId)) return failure(WHOLE_STORE_REQUIRED);
  if (!isConnectable(device)) return failure(`Channels can only be read from a recorder the server can reach. This one is "${modeLabel(device.connectionMode)}".`);
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
