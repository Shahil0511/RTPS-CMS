import "server-only";
import { and, eq, gte, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { alertRecipients, cameras, devices, downtimeIncidents, stores, type AlertRecipient, type DowntimeIncident } from "@/db/schema";
import { queueEmails, type OutgoingEmail } from "./mailer";
import { getAlertSettings } from "./settings";
import { renderAlertEmail, type AlertEvent, type AlertLocation } from "./templates";

/**
 * Offline / restored email alerts, run after every health check (after syncIncidents).
 *
 *  - OFFLINE: open incident older than offlineGraceMinutes (counted from graceFrom when set, else
 *    startedAt) with downAlertedAt null.
 *  - RESTORED: closed incident with downAlertedAt set and upAlertedAt null, once it has stayed closed
 *    for the grace period (debounce: going down again within it reopens the incident, see incidents.ts).
 *    A recorder's RESTORED line names the cameras that are still offline; those are then alerted on
 *    their own (incidents.ts clears their downAlertedAt and sets graceFrom).
 *  - Outage that started and ended between two checks but lasted longer than the grace period
 *    (only possible when the check interval exceeds the grace): one RESTORED line, so it is not lost.
 *  - Shorter flaps never email; they stay in the downtime log.
 *  - A recorder outage is one line with "N cameras affected"; its cameras (child incidents) are folded in.
 *  - One email per recipient per run, listing all new events of the locations they cover.
 *  - Closed incidents that were never alerted are marked handled (upAlertedAt) once they are older than
 *    the look-back window, so the candidate query (partial index on up_alerted_at is null) stays small.
 *  - Runs under the cross-process alert advisory lock (lock.ts).
 *  - downAlertedAt / upAlertedAt are set in the same transaction that queues the emails, also when
 *    SMTP is not configured (rows become SKIPPED_NO_SMTP) or nobody is subscribed, so nothing retries forever.
 */

export interface AlertDispatchResult {
  offline: number;
  restored: number;
  emails: number;
  skippedReason?: string;
}

/** Restore notices older than this are marked handled without an email (e.g. alerts were switched off). */
const STALE_RESTORE_MS = 6 * 3600 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __vmsAlertDispatch: boolean | undefined;
}

const secondsBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000));

export async function dispatchAlerts(now: Date = new Date()): Promise<AlertDispatchResult> {
  const result: AlertDispatchResult = { offline: 0, restored: 0, emails: 0 };
  if (globalThis.__vmsAlertDispatch) return { ...result, skippedReason: "Dispatch already running" };
  globalThis.__vmsAlertDispatch = true;
  try {
    const settings = await getAlertSettings();
    if (!settings.alertsEnabled) return { ...result, skippedReason: "Alerts are disabled" };
    const graceMs = settings.offlineGraceMinutes * 60_000;
    const graceCutoff = new Date(now.getTime() - graceMs);

    // Candidates: open incidents never alerted, closed incidents awaiting a restore notice,
    // and closed never-alerted incidents that ended recently (missed between two checks).
    const recentCutoff = new Date(now.getTime() - Math.max(graceMs, 60_000) - 3600 * 1000);
    // Old flaps that never alerted can no longer produce an email: mark them handled so they leave
    // the pending set (downtime_incidents_pending_alert_idx: up_alerted_at is null).
    await db
      .update(downtimeIncidents)
      .set({ upAlertedAt: now })
      .where(
        and(
          isNull(downtimeIncidents.upAlertedAt),
          isNull(downtimeIncidents.downAlertedAt),
          isNotNull(downtimeIncidents.endedAt),
          lt(downtimeIncidents.endedAt, recentCutoff),
        ),
      );
    const candidates = await db
      .select()
      .from(downtimeIncidents)
      .where(
        and(
          isNull(downtimeIncidents.upAlertedAt),
          or(
            and(isNull(downtimeIncidents.endedAt), isNull(downtimeIncidents.downAlertedAt)),
            and(isNotNull(downtimeIncidents.endedAt), isNotNull(downtimeIncidents.downAlertedAt)),
            and(isNotNull(downtimeIncidents.endedAt), isNull(downtimeIncidents.downAlertedAt), gte(downtimeIncidents.endedAt, recentCutoff)),
          ),
        ),
      );
    if (candidates.length === 0) return result;

    // Parents of camera incidents (recorder outages), including ones not in the candidate set.
    const byId = new Map(candidates.map((i) => [i.id, i]));
    const missingParents = [...new Set(candidates.map((i) => i.parentIncidentId).filter((p): p is number => p != null && !byId.has(p)))];
    const parents = new Map<number, DowntimeIncident>(byId);
    for (let i = 0; i < missingParents.length; i += 500) {
      const rows = await db.select().from(downtimeIncidents).where(inArray(downtimeIncidents.id, missingParents.slice(i, i + 500)));
      for (const r of rows) parents.set(r.id, r);
    }
    const parentOf = (inc: DowntimeIncident): DowntimeIncident | null => {
      if (!inc.parentIncidentId) return null;
      const p = parents.get(inc.parentIncidentId);
      return p && p.entityType === "DEVICE" ? p : null;
    };

    // ---- Decide what to send ---------------------------------------------
    const markDown = new Set<number>();
    const markUp = new Set<number>();
    const offlineEvents: Array<{ inc: DowntimeIncident }> = [];
    const restoredEvents: Array<{ inc: DowntimeIncident; missed: boolean }> = [];

    const isOpen = (i: DowntimeIncident) => i.endedAt == null;
    const pastGrace = (i: DowntimeIncident) => (i.graceFrom ?? i.startedAt).getTime() <= graceCutoff.getTime();
    /** Restore notices wait until the entity has stayed up for the grace period. */
    const restoreDue = (i: DowntimeIncident) => i.endedAt != null && i.endedAt.getTime() <= graceCutoff.getTime();
    const restorePending = (i: DowntimeIncident) => !isOpen(i) && i.downAlertedAt != null && i.upAlertedAt == null && !restoreDue(i);
    // Closed without ever alerting, yet down for longer than the grace period (counted like pastGrace,
    // so a camera whose recorder came back is measured from the recorder's end, not its own start).
    const missedOutage = (i: DowntimeIncident) =>
      graceMs > 0 && i.endedAt != null && i.endedAt.getTime() - (i.graceFrom ?? i.startedAt).getTime() >= graceMs;
    const willAlertDown = (dev: DowntimeIncident) => dev.downAlertedAt != null || (isOpen(dev) && dev.downAlertedAt == null && pastGrace(dev));

    // Recorders first.
    for (const inc of candidates) {
      if (inc.entityType !== "DEVICE") continue;
      if (isOpen(inc)) {
        if (inc.downAlertedAt == null && pastGrace(inc)) {
          offlineEvents.push({ inc });
          markDown.add(inc.id);
        }
      } else if (inc.downAlertedAt != null) {
        if (!restoreDue(inc)) continue;
        markUp.add(inc.id);
        if (now.getTime() - (inc.endedAt as Date).getTime() <= STALE_RESTORE_MS) restoredEvents.push({ inc, missed: false });
      } else if (missedOutage(inc)) {
        restoredEvents.push({ inc, missed: true });
        markDown.add(inc.id);
        markUp.add(inc.id);
      }
    }

    const restoredIds = new Set(restoredEvents.map((e) => e.inc.id));
    for (const inc of candidates) {
      if (inc.entityType !== "CAMERA") continue;
      const parent = parentOf(inc);
      if (isOpen(inc)) {
        if (inc.downAlertedAt != null) continue;
        if (parent && isOpen(parent)) {
          // Caused by the recorder: reported on the recorder's line, or waits for it.
          if (willAlertDown(parent)) markDown.add(inc.id);
          continue;
        }
        if (pastGrace(inc)) {
          offlineEvents.push({ inc });
          markDown.add(inc.id);
        }
      } else if (inc.downAlertedAt != null) {
        if (!restoreDue(inc)) continue;
        // Its recorder's restore is still being debounced: wait and be folded into that line.
        if (parent && restorePending(parent)) continue;
        markUp.add(inc.id);
        if (now.getTime() - (inc.endedAt as Date).getTime() > STALE_RESTORE_MS) continue;
        // Restored together with its recorder: folded into the recorder's restore line.
        if (parent && restoredIds.has(parent.id)) continue;
        restoredEvents.push({ inc, missed: false });
      } else if (missedOutage(inc)) {
        // Outage missed between two checks. If its recorder's line covers it, fold it in.
        markDown.add(inc.id);
        markUp.add(inc.id);
        if (parent && restoredIds.has(parent.id)) continue;
        restoredEvents.push({ inc, missed: true });
      }
    }

    if (markDown.size === 0 && markUp.size === 0) return result;

    // ---- Context for the email lines -------------------------------------
    const events = [...offlineEvents, ...restoredEvents];
    const storeIds = [...new Set(events.map((e) => e.inc.storeId).filter((s): s is string => Boolean(s)))];
    const deviceEvents = events.filter((e) => e.inc.entityType === "DEVICE");
    const deviceIncidentIds = deviceEvents.map((e) => e.inc.id);
    const eventDeviceIds = [...new Set(deviceEvents.map((e) => e.inc.deviceId).filter((s): s is string => Boolean(s)))];

    const [storeRows, childRows, recorderCameras, deviceRows, recipients] = await Promise.all([
      storeIds.length ? db.select({ id: stores.id, name: stores.name, code: stores.code, kind: stores.kind }).from(stores).where(inArray(stores.id, storeIds)) : Promise.resolve([]),
      deviceIncidentIds.length
        ? db.select().from(downtimeIncidents).where(and(eq(downtimeIncidents.entityType, "CAMERA"), inArray(downtimeIncidents.parentIncidentId, deviceIncidentIds)))
        : Promise.resolve([]),
      eventDeviceIds.length
        ? db.select({ id: cameras.id, name: cameras.name, deviceId: cameras.deviceId }).from(cameras).where(and(inArray(cameras.deviceId, eventDeviceIds), eq(cameras.isEnabled, true)))
        : Promise.resolve([]),
      db.select({ id: devices.id, name: devices.name }).from(devices),
      db.select().from(alertRecipients).where(eq(alertRecipients.isActive, true)),
    ]);
    const cameraIds = [...new Set([...events.map((e) => e.inc.cameraId), ...childRows.map((c) => c.cameraId)].filter((s): s is string => Boolean(s)))];
    const cameraRows = cameraIds.length
      ? await db.select({ id: cameras.id, name: cameras.name, channel: cameras.channel, deviceId: cameras.deviceId }).from(cameras).where(inArray(cameras.id, cameraIds))
      : [];

    const storeById = new Map(storeRows.map((s) => [s.id, s]));
    const cameraById = new Map(cameraRows.map((c) => [c.id, c]));
    const deviceName = new Map(deviceRows.map((d) => [d.id, d.name]));
    const childrenOf = new Map<number, DowntimeIncident[]>();
    for (const c of childRows) {
      if (c.parentIncidentId == null) continue;
      childrenOf.set(c.parentIncidentId, [...(childrenOf.get(c.parentIncidentId) ?? []), c]);
    }
    const camerasOnDevice = new Map<string, string[]>();
    for (const c of recorderCameras) {
      if (!c.deviceId) continue;
      camerasOnDevice.set(c.deviceId, [...(camerasOnDevice.get(c.deviceId) ?? []), c.name]);
    }
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

    const locationOf = (inc: DowntimeIncident): AlertLocation => {
      const s = inc.storeId ? storeById.get(inc.storeId) : undefined;
      return { storeId: inc.storeId, name: s?.name ?? inc.storeName ?? "Unknown location", code: s?.code ?? null, kind: s?.kind ?? null };
    };

    const toEvent = (inc: DowntimeIncident, type: "OFFLINE" | "RESTORED"): AlertEvent => {
      const cam = inc.cameraId ? cameraById.get(inc.cameraId) : undefined;
      const downtimeSeconds = type === "OFFLINE" || !inc.endedAt ? secondsBetween(inc.startedAt, now) : (inc.durationSeconds ?? secondsBetween(inc.startedAt, inc.endedAt));
      const ev: AlertEvent = {
        type,
        entityType: inc.entityType,
        incidentId: inc.id,
        location: locationOf(inc),
        cameraId: inc.cameraId,
        deviceId: inc.deviceId,
        cameraName: inc.entityType === "CAMERA" ? (cam?.name ?? inc.entityName) : null,
        channel: cam?.channel ?? null,
        recorderName: inc.entityType === "DEVICE" ? inc.entityName : cam?.deviceId ? (deviceName.get(cam.deviceId) ?? null) : null,
        startedAt: inc.startedAt,
        endedAt: type === "RESTORED" ? inc.endedAt : null,
        downtimeSeconds,
        detail: type === "OFFLINE" ? inc.startDetail : inc.endDetail ? `${inc.endDetail}${inc.startDetail ? ` (was: ${inc.startDetail})` : ""}` : inc.startDetail,
      };
      if (inc.entityType === "DEVICE") {
        const all = childrenOf.get(inc.id) ?? [];
        // OFFLINE: cameras still down with it; RESTORED: every camera the outage took down.
        const children = type === "OFFLINE" ? all.filter((c) => c.endedAt == null) : all;
        let names = children.map((c) => (c.cameraId ? (cameraById.get(c.cameraId)?.name ?? c.entityName) : c.entityName));
        if (names.length === 0 && inc.deviceId) names = camerasOnDevice.get(inc.deviceId) ?? []; // channels never seen online yet
        ev.affectedCameras = names.length;
        ev.affectedCameraNames = names.sort(byName).slice(0, 20);
        if (type === "RESTORED") {
          const still = all.filter((c) => c.endedAt == null);
          ev.stillOfflineCameras = still.length;
          ev.stillOfflineCameraNames = still.map((c) => (c.cameraId ? (cameraById.get(c.cameraId)?.name ?? c.entityName) : c.entityName)).sort(byName).slice(0, 20);
        }
      }
      return ev;
    };

    const offline = offlineEvents.map((e) => toEvent(e.inc, "OFFLINE"));
    const restored = restoredEvents.map((e) => toEvent(e.inc, "RESTORED"));
    result.offline = offline.length;
    result.restored = restored.length;

    // ---- Recipients: one email per address per run -----------------------
    const byEmail = new Map<string, AlertRecipient[]>();
    for (const r of recipients) {
      const key = r.email.trim().toLowerCase();
      if (!key) continue;
      byEmail.set(key, [...(byEmail.get(key) ?? []), r]);
    }
    const covers = (rows: AlertRecipient[], storeId: string | null, want: (r: AlertRecipient) => boolean) =>
      rows.some((r) => want(r) && (r.storeId == null || (storeId != null && r.storeId === storeId)));

    const emails: OutgoingEmail[] = [];
    for (const rows of byEmail.values()) {
      const to = rows[0]!.email.trim();
      const mine = [
        ...offline.filter((e) => covers(rows, e.location.storeId, (r) => r.onOffline)),
        ...restored.filter((e, i) => covers(rows, e.location.storeId, (r) => (restoredEvents[i]!.missed ? r.onOffline || r.onOnline : r.onOnline))),
      ];
      if (mine.length === 0) continue;
      const m = renderAlertEmail(mine, now);
      emails.push({ kind: m.kind, to, subject: m.subject, text: m.text, html: m.html });
    }

    // ---- Queue + mark atomically -----------------------------------------
    await db.transaction(async (tx) => {
      await queueEmails(emails, tx);
      const down = [...markDown];
      const up = [...markUp];
      for (let i = 0; i < down.length; i += 500) {
        await tx
          .update(downtimeIncidents)
          .set({ downAlertedAt: now })
          .where(and(inArray(downtimeIncidents.id, down.slice(i, i + 500)), isNull(downtimeIncidents.downAlertedAt)));
      }
      for (let i = 0; i < up.length; i += 500) {
        await tx
          .update(downtimeIncidents)
          .set({ upAlertedAt: now })
          .where(and(inArray(downtimeIncidents.id, up.slice(i, i + 500)), isNull(downtimeIncidents.upAlertedAt), isNotNull(downtimeIncidents.endedAt), lte(downtimeIncidents.endedAt, now)));
      }
    });
    result.emails = emails.length;
    return result;
  } finally {
    globalThis.__vmsAlertDispatch = false;
  }
}
