import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  cameras,
  cameraStatusEvents,
  devices,
  deviceStatusEvents,
  downtimeIncidents,
  stores,
  type CameraStatus,
  type DowntimeIncident,
  type NewDowntimeIncident,
} from "@/db/schema";
import { env } from "@/env";
import { notMonitoredReason } from "@/lib/devices/health";
import { getAlertSettings } from "./settings";

/**
 * Downtime log. Runs after every health check (under the alert advisory lock, see lock.ts)
 * and reconciles vms.downtime_incidents with the statuses the check just wrote, so it is
 * idempotent and also repairs state after a restart:
 *  - entity OFFLINE without an open incident  -> open one (startedAt = time of its
 *    OFFLINE status event, else lastOnlineAt, else now)
 *  - entity ONLINE with an open incident      -> close it (endedAt = time of its ONLINE event)
 *  - entity no longer monitored (disabled, pending network, cloud-only) -> close it as
 *    "Monitoring stopped" without a restore email
 *  - UNKNOWN (status could not be determined) -> leave as is
 * Entities that have never been seen online (lastOnlineAt null) are configuration gaps,
 * not outages, and never open incidents. At most one open incident exists per entity
 * (also enforced by partial unique indexes).
 *
 * Alert-related rules applied here (dispatch.ts sends the emails):
 *  - Backfill: an incident opened for an outage that began before alerting could see it
 *    (startedAt older than the grace period at creation) is marked `backfilled` with
 *    downAlertedAt already set, and its close sets upAlertedAt: no backlog email either way.
 *  - Debounce: an entity that goes down again within the grace period after an ALERTED
 *    incident closed (restore notice not sent yet) reopens that incident instead of
 *    starting a new one, so a flap sends neither a RESTORED nor a second OFFLINE email.
 *  - Recorder back, camera still down: when a recorder incident closes, its still-open,
 *    non-backfilled camera incidents get downAlertedAt cleared and graceFrom = the
 *    recorder's end, so each camera is then alerted on its own (until then it was only
 *    covered by the recorder's line). parentIncidentId is kept: it records the cause and
 *    lets the recorder's RESTORED line name the cameras that are still offline.
 */

export interface IncidentSyncResult {
  opened: number;
  closed: number;
  linked: number;
  reopened: number;
}

type Desired = "DOWN" | "UP" | "STOPPED" | "HOLD";

declare global {
  // eslint-disable-next-line no-var
  var __vmsIncidentSync: boolean | undefined;
}

function desiredState(status: CameraStatus, stopReason: string | null): Desired {
  if (stopReason) return "STOPPED";
  if (status === "OFFLINE") return "DOWN";
  if (status === "ONLINE") return "UP";
  return "HOLD";
}

/** Latest status event per entity, for accurate start/end times. */
async function latestEvents(kind: "CAMERA" | "DEVICE", ids: string[]): Promise<Map<string, { status: CameraStatus; at: Date }>> {
  const out = new Map<string, { status: CameraStatus; at: Date }>();
  if (ids.length === 0) return out;
  if (kind === "CAMERA") {
    const rows = await db
      .selectDistinctOn([cameraStatusEvents.cameraId], { id: cameraStatusEvents.cameraId, status: cameraStatusEvents.status, at: cameraStatusEvents.createdAt })
      .from(cameraStatusEvents)
      .where(inArray(cameraStatusEvents.cameraId, ids))
      .orderBy(cameraStatusEvents.cameraId, desc(cameraStatusEvents.createdAt));
    for (const r of rows) out.set(r.id, { status: r.status, at: r.at });
  } else {
    const rows = await db
      .selectDistinctOn([deviceStatusEvents.deviceId], { id: deviceStatusEvents.deviceId, status: deviceStatusEvents.status, at: deviceStatusEvents.createdAt })
      .from(deviceStatusEvents)
      .where(inArray(deviceStatusEvents.deviceId, ids))
      .orderBy(deviceStatusEvents.deviceId, desc(deviceStatusEvents.createdAt));
    for (const r of rows) out.set(r.id, { status: r.status, at: r.at });
  }
  return out;
}

const seconds = (from: Date, to: Date) => Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));

/** Most recent alerted, not-yet-restore-notified incident per entity that ended at/after `since`. */
async function reopenableIncidents(entityType: "DEVICE" | "CAMERA", ids: string[], since: Date): Promise<DowntimeIncident[]> {
  if (ids.length === 0) return [];
  const out: DowntimeIncident[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(
      ...(await db
        .select()
        .from(downtimeIncidents)
        .where(
          and(
            eq(downtimeIncidents.entityType, entityType),
            inArray(entityType === "DEVICE" ? downtimeIncidents.deviceId : downtimeIncidents.cameraId, chunk),
            isNotNull(downtimeIncidents.endedAt),
            gte(downtimeIncidents.endedAt, since),
            isNotNull(downtimeIncidents.downAlertedAt),
            isNull(downtimeIncidents.upAlertedAt),
            eq(downtimeIncidents.backfilled, false),
          ),
        )
        .orderBy(desc(downtimeIncidents.endedAt), desc(downtimeIncidents.id))),
    );
  }
  return out;
}

export async function syncIncidents(at: Date = new Date()): Promise<IncidentSyncResult> {
  const result: IncidentSyncResult = { opened: 0, closed: 0, linked: 0, reopened: 0 };
  if (globalThis.__vmsIncidentSync) return result;
  globalThis.__vmsIncidentSync = true;
  try {
    const { offlineGraceMinutes } = await getAlertSettings();
    const graceMs = offlineGraceMinutes * 60_000;
    // Older than this when first seen = the outage predates what alerting could see. Never below a few
    // check intervals, so a normal detection (startedAt = this run's OFFLINE event) is never a backfill.
    const backfillCutoff = new Date(at.getTime() - Math.max(graceMs, 3 * env.HEALTH_CHECK_INTERVAL_SECONDS * 1000, 60_000));
    const reopenCutoff = new Date(at.getTime() - graceMs);

    const [storeRows, deviceRows, cameraRows, openRows] = await Promise.all([
      db.select({ id: stores.id, name: stores.name }).from(stores),
      db
        .select({
          id: devices.id,
          name: devices.name,
          storeId: devices.storeId,
          status: devices.status,
          lastOnlineAt: devices.lastOnlineAt,
          lastError: devices.lastError,
          isEnabled: devices.isEnabled,
          connectionMode: devices.connectionMode,
          host: devices.host,
        })
        .from(devices),
      db
        .select({
          id: cameras.id,
          name: cameras.name,
          storeId: cameras.storeId,
          deviceId: cameras.deviceId,
          host: cameras.host,
          status: cameras.status,
          lastOnlineAt: cameras.lastOnlineAt,
          lastError: cameras.lastError,
          isEnabled: cameras.isEnabled,
        })
        .from(cameras),
      db.select().from(downtimeIncidents).where(isNull(downtimeIncidents.endedAt)).orderBy(downtimeIncidents.startedAt, downtimeIncidents.id),
    ]);

    const storeName = new Map(storeRows.map((s) => [s.id, s.name]));
    const deviceById = new Map(deviceRows.map((d) => [d.id, d]));

    // Index open incidents; close accidental duplicates (keep the oldest).
    const openDevice = new Map<string, DowntimeIncident>();
    const openCamera = new Map<string, DowntimeIncident>();
    const toClose: Array<{ inc: DowntimeIncident; endedAt: Date; endDetail: string; silent: boolean }> = [];
    for (const inc of openRows) {
      const key = inc.entityType === "DEVICE" ? inc.deviceId : inc.cameraId;
      const map = inc.entityType === "DEVICE" ? openDevice : openCamera;
      if (!key) {
        // The camera/recorder was deleted (its link is cleared by ON DELETE SET NULL).
        toClose.push({ inc, endedAt: at, endDetail: "Entity no longer exists", silent: true });
      } else if (map.has(key)) {
        toClose.push({ inc, endedAt: at, endDetail: "Duplicate incident merged", silent: true });
      } else {
        map.set(key, inc);
      }
    }

    // ---- Recorders --------------------------------------------------------
    const deviceDesired = new Map<string, { desired: Desired; reason: string | null }>();
    for (const d of deviceRows) {
      const reason = notMonitoredReason(d);
      deviceDesired.set(d.id, { desired: desiredState(d.status, reason), reason });
    }

    // ---- Cameras ----------------------------------------------------------
    const cameraDesired = new Map<string, { desired: Desired; reason: string | null }>();
    for (const c of cameraRows) {
      const device = c.deviceId ? deviceById.get(c.deviceId) : undefined;
      let reason: string | null = null;
      if (!c.isEnabled) reason = "Camera disabled";
      else if (device) reason = notMonitoredReason(device);
      else if (!c.host) reason = "No recorder or host configured";
      cameraDesired.set(c.id, { desired: desiredState(c.status, reason), reason });
    }

    // Rows deleted between the reads above.
    for (const [id, inc] of openDevice) if (!deviceDesired.has(id)) toClose.push({ inc, endedAt: at, endDetail: "Recorder removed", silent: true });
    for (const [id, inc] of openCamera) if (!cameraDesired.has(id)) toClose.push({ inc, endedAt: at, endDetail: "Camera removed", silent: true });

    let devToOpen = deviceRows.filter((d) => deviceDesired.get(d.id)?.desired === "DOWN" && !openDevice.has(d.id) && d.lastOnlineAt);
    let camToOpen = cameraRows.filter((c) => cameraDesired.get(c.id)?.desired === "DOWN" && !openCamera.has(c.id) && c.lastOnlineAt);

    // Debounce: down again within the grace period of an alerted incident whose restore notice has
    // not gone out yet -> reopen that incident (it is still the same outage).
    if (graceMs > 0 && (devToOpen.length || camToOpen.length)) {
      const [devPrev, camPrev] = await Promise.all([
        reopenableIncidents("DEVICE", devToOpen.map((d) => d.id), reopenCutoff),
        reopenableIncidents("CAMERA", camToOpen.map((c) => c.id), reopenCutoff),
      ]);
      const reopen = async (rows: DowntimeIncident[], key: (i: DowntimeIncident) => string | null, into: Map<string, DowntimeIncident>) => {
        for (const inc of rows) {
          const k = key(inc);
          if (!k || into.has(k)) continue; // latest per entity only (rows are newest first)
          const [row] = await db
            .update(downtimeIncidents)
            .set({ endedAt: null, durationSeconds: null, endDetail: null })
            .where(and(eq(downtimeIncidents.id, inc.id), isNotNull(downtimeIncidents.endedAt), isNull(downtimeIncidents.upAlertedAt)))
            .returning();
          if (row) {
            into.set(k, row);
            result.reopened += 1;
          }
        }
      };
      await reopen(devPrev, (i) => i.deviceId, openDevice);
      await reopen(camPrev, (i) => i.cameraId, openCamera);
      devToOpen = devToOpen.filter((d) => !openDevice.has(d.id));
      camToOpen = camToOpen.filter((c) => !openCamera.has(c.id));
    }

    const devToCloseUp = [...openDevice.entries()].filter(([id]) => deviceDesired.get(id)?.desired === "UP");
    const camToCloseUp = [...openCamera.entries()].filter(([id]) => cameraDesired.get(id)?.desired === "UP");

    const [devEvents, camEvents] = await Promise.all([
      latestEvents("DEVICE", [...devToOpen.map((d) => d.id), ...devToCloseUp.map(([id]) => id)]),
      latestEvents("CAMERA", [...camToOpen.map((c) => c.id), ...camToCloseUp.map(([id]) => id)]),
    ]);

    const startOf = (ev: { status: CameraStatus; at: Date } | undefined, lastOnlineAt: Date | null): Date => {
      const t = ev?.status === "OFFLINE" ? ev.at : (lastOnlineAt ?? at);
      return t.getTime() > at.getTime() ? at : t;
    };
    const endOf = (ev: { status: CameraStatus; at: Date } | undefined, startedAt: Date): Date => {
      if (ev?.status === "ONLINE" && ev.at.getTime() >= startedAt.getTime() && ev.at.getTime() <= at.getTime()) return ev.at;
      return at;
    };
    // Outage already older than the grace period when first seen: logged, never emailed.
    const backfill = (v: NewDowntimeIncident): NewDowntimeIncident =>
      v.startedAt.getTime() < backfillCutoff.getTime() ? { ...v, backfilled: true, downAlertedAt: at } : v;

    // Open recorder incidents first so camera incidents can point at them.
    if (devToOpen.length) {
      const values: NewDowntimeIncident[] = devToOpen.map((d) =>
        backfill({
          entityType: "DEVICE",
          deviceId: d.id,
          storeId: d.storeId,
          entityName: d.name,
          storeName: storeName.get(d.storeId) ?? null,
          startedAt: startOf(devEvents.get(d.id), d.lastOnlineAt),
          startDetail: d.lastError,
        }),
      );
      const inserted = await db.insert(downtimeIncidents).values(values).returning();
      for (const inc of inserted) if (inc.deviceId) openDevice.set(inc.deviceId, inc);
      result.opened += inserted.length;
    }

    // A camera's outage is "caused by" its recorder while the recorder is down.
    const parentFor = (deviceId: string | null): number | null => {
      if (!deviceId) return null;
      if (deviceDesired.get(deviceId)?.desired !== "DOWN") return null;
      return openDevice.get(deviceId)?.id ?? null;
    };

    if (camToOpen.length) {
      const values: NewDowntimeIncident[] = camToOpen.map((c) =>
        backfill({
          entityType: "CAMERA",
          cameraId: c.id,
          // deviceId stays null on camera rows: it identifies DEVICE incidents only. The recorder link is parentIncidentId.
          storeId: c.storeId,
          entityName: c.name,
          storeName: storeName.get(c.storeId) ?? null,
          startedAt: startOf(camEvents.get(c.id), c.lastOnlineAt),
          startDetail: c.lastError,
          parentIncidentId: parentFor(c.deviceId),
        }),
      );
      // Chunk to stay well inside the bind-parameter limit on large estates.
      for (let i = 0; i < values.length; i += 500) {
        const inserted = await db.insert(downtimeIncidents).values(values.slice(i, i + 500)).returning({ id: downtimeIncidents.id });
        result.opened += inserted.length;
      }
    }

    // Link camera incidents (not alerted yet) to their recorder's open incident: ones that opened
    // before the recorder was detected down, and ones still pointing at an earlier, closed recorder incident.
    const cameraById = new Map(cameraRows.map((c) => [c.id, c]));
    const linkGroups = new Map<number, number[]>();
    for (const [camId, inc] of openCamera) {
      if (inc.downAlertedAt) continue;
      if (cameraDesired.get(camId)?.desired !== "DOWN") continue;
      const parent = parentFor(cameraById.get(camId)?.deviceId ?? null);
      if (!parent || inc.parentIncidentId === parent) continue;
      const list = linkGroups.get(parent) ?? [];
      list.push(inc.id);
      linkGroups.set(parent, list);
    }
    for (const [parent, ids] of linkGroups) {
      await db
        .update(downtimeIncidents)
        .set({ parentIncidentId: parent })
        .where(and(inArray(downtimeIncidents.id, ids), isNull(downtimeIncidents.downAlertedAt), isNull(downtimeIncidents.endedAt)));
      result.linked += ids.length;
    }

    // Closures
    for (const [id, inc] of devToCloseUp) {
      toClose.push({ inc, endedAt: endOf(devEvents.get(id), inc.startedAt), endDetail: "Recorder reachable again", silent: false });
    }
    for (const [id, inc] of camToCloseUp) {
      toClose.push({ inc, endedAt: endOf(camEvents.get(id), inc.startedAt), endDetail: "Camera back online", silent: false });
    }
    for (const [id, inc] of openDevice) {
      const d = deviceDesired.get(id);
      if (d?.desired === "STOPPED") toClose.push({ inc, endedAt: at, endDetail: `Monitoring stopped: ${d.reason}`, silent: true });
    }
    for (const [id, inc] of openCamera) {
      const c = cameraDesired.get(id);
      if (c?.desired === "STOPPED") toClose.push({ inc, endedAt: at, endDetail: `Monitoring stopped: ${c.reason}`, silent: true });
    }

    const seen = new Set<number>();
    const closedDevices: Array<{ id: number; endedAt: Date }> = [];
    for (const { inc, endedAt, endDetail, silent } of toClose) {
      if (seen.has(inc.id)) continue;
      seen.add(inc.id);
      const end = endedAt.getTime() < inc.startedAt.getTime() ? inc.startedAt : endedAt;
      const [row] = await db
        .update(downtimeIncidents)
        .set({
          endedAt: end,
          durationSeconds: seconds(inc.startedAt, end),
          endDetail,
          // Silent closures (monitoring stopped, duplicates) and backfilled incidents never send a restore email.
          ...(silent || inc.backfilled ? { upAlertedAt: at } : {}),
        })
        .where(and(eq(downtimeIncidents.id, inc.id), isNull(downtimeIncidents.endedAt)))
        .returning({ id: downtimeIncidents.id });
      if (!row) continue;
      result.closed += 1;
      if (inc.entityType === "DEVICE") closedDevices.push({ id: inc.id, endedAt: end });
    }

    // Recorder back but some of its cameras still down: they were only covered by the recorder's
    // alert, so each now gets its own grace period (from the recorder's end) and its own alert.
    for (const dev of closedDevices) {
      await db
        .update(downtimeIncidents)
        .set({ downAlertedAt: null, graceFrom: dev.endedAt })
        .where(
          and(
            eq(downtimeIncidents.parentIncidentId, dev.id),
            eq(downtimeIncidents.entityType, "CAMERA"),
            isNull(downtimeIncidents.endedAt),
            eq(downtimeIncidents.backfilled, false),
          ),
        );
    }

    return result;
  } finally {
    globalThis.__vmsIncidentSync = false;
  }
}
