import "server-only";
import { and, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { alertRecipients, cameras, devices, downtimeIncidents, settings, stores, type DowntimeIncident } from "@/db/schema";
import { env } from "@/env";
import { notMonitoredReason } from "@/lib/devices/health";
import { queueEmails, type OutgoingEmail } from "./mailer";
import { getAlertSettings } from "./settings";
import { renderDailyReportEmail, type AlertLocation, type ReportData, type ReportIncidentRow, type ReportLocation, type ReportOfflineRow } from "./templates";
import { previousDayRange, zonedDateKey, zonedDayRange, zonedParts } from "./time";

/**
 * Daily camera/recorder health report, built from vms.downtime_incidents.
 * A day is the local calendar day in ALERT_TIMEZONE. Every incident overlapping the day is
 * listed with its downtime clipped to the day and its total; camera outages caused by a
 * recorder outage are folded into the recorder's line. Availability is camera time online
 * over monitored camera time. Recorders that are not monitored (pending network, cloud-only,
 * disabled) are excluded and only counted in a note.
 */

export interface DailyReportSummary {
  incidents: number;
  camerasAffected: number;
  devicesAffected: number;
  stillOffline: number;
  totalDowntimeSeconds: number;
}

export interface DailyReport {
  subject: string;
  text: string;
  html: string;
  summary: DailyReportSummary;
}

const LAST_SENT_KEY = "alerts.lastDailyReportDate";
const secondsBetween = (a: number, b: number) => Math.max(0, Math.round((b - a) / 1000));

export interface DailyReportScope {
  /** null = all locations. */
  storeIds: string[] | null;
  /**
   * Optional camera-level limits (SessionUser.cameraScope): storeId -> visible camera ids. Cameras and
   * camera incidents of a listed store are limited to those ids; recorders stay store-wide.
   */
  cameraScope?: Record<string, string[]>;
}

/** Collects everything the report needs. storeIds null = all locations. */
export async function buildDailyReportData(opts: DailyReportScope & { date: Date; now?: Date }): Promise<ReportData> {
  const tz = env.ALERT_TIMEZONE;
  const now = opts.now ?? new Date();
  const day = zonedDayRange(opts.date, tz);
  const dayStart = day.start.getTime();
  // A report for today only covers the time elapsed so far.
  const dayEnd = Math.min(day.end.getTime(), Math.max(now.getTime(), dayStart));
  const scope = opts.storeIds;
  const inScope = (storeId: string | null) => scope == null || (storeId != null && scope.includes(storeId));

  if (scope && scope.length === 0) {
    return emptyReport(day, now, "No locations");
  }

  const storeFilter = (col: typeof downtimeIncidents.storeId): SQL | undefined => (scope ? inArray(col, scope) : undefined);

  const [storeRows, deviceRows, allCameraRows, allDayIncidents, allOpenIncidents] = await Promise.all([
    db.select({ id: stores.id, name: stores.name, code: stores.code, kind: stores.kind }).from(stores).where(scope ? inArray(stores.id, scope) : undefined),
    db
      .select({ id: devices.id, name: devices.name, storeId: devices.storeId, isEnabled: devices.isEnabled, connectionMode: devices.connectionMode, host: devices.host, lastOnlineAt: devices.lastOnlineAt })
      .from(devices)
      .where(scope ? inArray(devices.storeId, scope) : undefined),
    db
      .select({ id: cameras.id, name: cameras.name, storeId: cameras.storeId, deviceId: cameras.deviceId, channel: cameras.channel, host: cameras.host, isEnabled: cameras.isEnabled, lastOnlineAt: cameras.lastOnlineAt })
      .from(cameras)
      .where(scope ? inArray(cameras.storeId, scope) : undefined),
    db
      .select()
      .from(downtimeIncidents)
      .where(
        and(
          lt(downtimeIncidents.startedAt, new Date(dayEnd)),
          or(isNull(downtimeIncidents.endedAt), gt(downtimeIncidents.endedAt, day.start)),
          storeFilter(downtimeIncidents.storeId),
        ),
      )
      .orderBy(downtimeIncidents.startedAt, downtimeIncidents.id),
    db.select().from(downtimeIncidents).where(and(isNull(downtimeIncidents.endedAt), storeFilter(downtimeIncidents.storeId))).orderBy(downtimeIncidents.startedAt, downtimeIncidents.id),
  ]);

  const limits = opts.cameraScope ?? {};
  const cameraVisible = (storeId: string | null, cameraId: string | null) => {
    const limit = storeId != null && Object.prototype.hasOwnProperty.call(limits, storeId) ? limits[storeId] : undefined;
    return limit === undefined || (cameraId != null && limit.includes(cameraId));
  };
  const incidentVisible = (i: DowntimeIncident) => i.entityType !== "CAMERA" || i.cameraId == null || cameraVisible(i.storeId, i.cameraId);
  const cameraRows = allCameraRows.filter((c) => cameraVisible(c.storeId, c.id));
  const dayIncidents = allDayIncidents.filter(incidentVisible);
  const openIncidents = allOpenIncidents.filter(incidentVisible);

  const storeById = new Map(storeRows.map((s) => [s.id, s]));
  const deviceById = new Map(deviceRows.map((d) => [d.id, d]));
  const cameraById = new Map(cameraRows.map((c) => [c.id, c]));

  const locationOf = (storeId: string | null, fallbackName: string | null): AlertLocation => {
    const s = storeId ? storeById.get(storeId) : undefined;
    return { storeId, name: s?.name ?? fallbackName ?? "Unknown location", code: s?.code ?? null, kind: s?.kind ?? null };
  };
  const recorderNameOf = (inc: DowntimeIncident): string | null => {
    if (inc.entityType === "DEVICE") return inc.entityName;
    const cam = inc.cameraId ? cameraById.get(inc.cameraId) : undefined;
    return cam?.deviceId ? (deviceById.get(cam.deviceId)?.name ?? null) : null;
  };
  const nameOf = (inc: DowntimeIncident) => (inc.entityType === "CAMERA" && inc.cameraId ? (cameraById.get(inc.cameraId)?.name ?? inc.entityName) : inc.entityName);
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

  // ---- Monitored estate -------------------------------------------------
  const notMonitored = { recorders: 0, pendingNetwork: 0, cloudOnly: 0, disabled: 0, other: 0 };
  const monitoredDevices = new Set<string>();
  for (const d of deviceRows) {
    const reason = notMonitoredReason(d);
    if (!reason) {
      monitoredDevices.add(d.id);
      continue;
    }
    notMonitored.recorders += 1;
    if (!d.isEnabled) notMonitored.disabled += 1;
    else if (d.connectionMode === "PENDING_NETWORK") notMonitored.pendingNetwork += 1;
    else if (d.connectionMode === "CLOUD_ONLY") notMonitored.cloudOnly += 1;
    else notMonitored.other += 1;
  }
  // A camera counts once it has been seen online at least once (otherwise it cannot open incidents).
  const monitoredCamerasByStore = new Map<string, number>();
  const monitoredRecordersByStore = new Map<string, number>();
  for (const c of cameraRows) {
    if (!c.isEnabled || !c.lastOnlineAt) continue;
    if (c.deviceId ? !monitoredDevices.has(c.deviceId) : !c.host) continue;
    monitoredCamerasByStore.set(c.storeId, (monitoredCamerasByStore.get(c.storeId) ?? 0) + 1);
  }
  for (const d of deviceRows) {
    if (monitoredDevices.has(d.id) && d.lastOnlineAt) monitoredRecordersByStore.set(d.storeId, (monitoredRecordersByStore.get(d.storeId) ?? 0) + 1);
  }

  // ---- Incidents of the day ---------------------------------------------
  const deviceIncidentIds = new Set(dayIncidents.filter((i) => i.entityType === "DEVICE").map((i) => i.id));
  const children = new Map<number, DowntimeIncident[]>();
  for (const i of dayIncidents) {
    if (i.entityType === "CAMERA" && i.parentIncidentId != null && deviceIncidentIds.has(i.parentIncidentId)) {
      children.set(i.parentIncidentId, [...(children.get(i.parentIncidentId) ?? []), i]);
    }
  }
  const clipped = (i: DowntimeIncident) => {
    const s = Math.max(i.startedAt.getTime(), dayStart);
    const e = Math.min(i.endedAt ? i.endedAt.getTime() : now.getTime(), dayEnd);
    return secondsBetween(s, Math.max(s, e));
  };
  const total = (i: DowntimeIncident) => i.durationSeconds ?? secondsBetween(i.startedAt.getTime(), (i.endedAt ?? now).getTime());

  const locations = new Map<string, ReportLocation>();
  const locKey = (storeId: string | null, name: string | null) => storeId ?? `name:${name ?? ""}`;
  const ensureLocation = (storeId: string | null, fallbackName: string | null): ReportLocation => {
    const key = locKey(storeId, fallbackName);
    let l = locations.get(key);
    if (!l) {
      l = {
        location: locationOf(storeId, fallbackName),
        monitoredCameras: storeId ? (monitoredCamerasByStore.get(storeId) ?? 0) : 0,
        monitoredRecorders: storeId ? (monitoredRecordersByStore.get(storeId) ?? 0) : 0,
        availabilityPct: null,
        downtimeSeconds: 0,
        incidents: [],
      };
      locations.set(key, l);
    }
    return l;
  };
  for (const s of storeRows) {
    if ((monitoredCamerasByStore.get(s.id) ?? 0) > 0 || (monitoredRecordersByStore.get(s.id) ?? 0) > 0) ensureLocation(s.id, s.name);
  }

  const cameraDownByStore = new Map<string, number>();
  const camerasAffected = new Set<string>();
  const devicesAffected = new Set<string>();
  let totalDowntimeSeconds = 0;

  for (const i of dayIncidents) {
    if (!inScope(i.storeId)) continue;
    const secs = clipped(i);
    if (i.entityType === "CAMERA") {
      if (i.cameraId) camerasAffected.add(i.cameraId);
      if (i.storeId) cameraDownByStore.set(i.storeId, (cameraDownByStore.get(i.storeId) ?? 0) + secs);
      // Folded into the recorder line.
      if (i.parentIncidentId != null && deviceIncidentIds.has(i.parentIncidentId)) continue;
    } else if (i.deviceId) {
      devicesAffected.add(i.deviceId);
    }
    const kids = i.entityType === "DEVICE" ? (children.get(i.id) ?? []) : [];
    const cam = i.cameraId ? cameraById.get(i.cameraId) : undefined;
    const row: ReportIncidentRow = {
      entityType: i.entityType,
      name: nameOf(i),
      recorderName: recorderNameOf(i),
      channel: cam?.channel ?? null,
      startedAt: i.startedAt,
      endedAt: i.endedAt,
      daySeconds: secs,
      totalSeconds: total(i),
      stillOffline: i.endedAt == null,
      detail: i.startDetail,
      ...(i.entityType === "DEVICE" ? { affectedCameras: kids.length, affectedCameraNames: kids.map(nameOf).sort(byName).slice(0, 12) } : {}),
    };
    const loc = ensureLocation(i.storeId, i.storeName);
    loc.incidents.push(row);
    loc.downtimeSeconds += secs;
    totalDowntimeSeconds += secs;
  }

  const dayLen = Math.max(0, (dayEnd - dayStart) / 1000);
  for (const l of locations.values()) {
    if (l.monitoredCameras > 0 && dayLen > 0) {
      const down = l.location.storeId ? (cameraDownByStore.get(l.location.storeId) ?? 0) : 0;
      const pct = 100 * (1 - down / (l.monitoredCameras * dayLen));
      l.availabilityPct = Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
    }
    l.incidents.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  // ---- Offline right now -------------------------------------------------
  const openDeviceIds = new Set(openIncidents.filter((i) => i.entityType === "DEVICE").map((i) => i.id));
  const openChildren = new Map<number, number>();
  for (const i of openIncidents) {
    if (i.entityType === "CAMERA" && i.parentIncidentId != null && openDeviceIds.has(i.parentIncidentId)) {
      openChildren.set(i.parentIncidentId, (openChildren.get(i.parentIncidentId) ?? 0) + 1);
    }
  }
  const currentlyOffline: ReportOfflineRow[] = [];
  for (const i of openIncidents) {
    if (i.entityType === "CAMERA" && i.parentIncidentId != null && openDeviceIds.has(i.parentIncidentId)) continue;
    const cam = i.cameraId ? cameraById.get(i.cameraId) : undefined;
    currentlyOffline.push({
      location: locationOf(i.storeId, i.storeName),
      entityType: i.entityType,
      name: nameOf(i),
      recorderName: recorderNameOf(i),
      channel: cam?.channel ?? null,
      since: i.startedAt,
      downtimeSeconds: secondsBetween(i.startedAt.getTime(), now.getTime()),
      detail: i.startDetail,
      ...(i.entityType === "DEVICE" ? { affectedCameras: openChildren.get(i.id) ?? 0 } : {}),
    });
  }
  currentlyOffline.sort((a, b) => a.location.name.localeCompare(b.location.name) || (a.entityType === b.entityType ? byName(a.name, b.name) : a.entityType === "DEVICE" ? -1 : 1));

  const locationList = [...locations.values()].sort((a, b) => a.location.name.localeCompare(b.location.name));
  const incidentCount = locationList.reduce((n, l) => n + l.incidents.length, 0);

  return {
    day,
    generatedAt: now,
    scopeLabel: scopeLabel(scope, storeRows),
    summary: {
      incidents: incidentCount,
      camerasAffected: camerasAffected.size,
      devicesAffected: devicesAffected.size,
      stillOffline: currentlyOffline.length,
      totalDowntimeSeconds,
    },
    locations: locationList,
    currentlyOffline,
    notMonitored,
  };
}

function scopeLabel(scope: string[] | null, storeRows: Array<{ id: string; name: string }>): string {
  if (scope == null) return "All locations";
  if (storeRows.length === 1) return storeRows[0]!.name;
  return `${storeRows.length} locations`;
}

function emptyReport(day: ReturnType<typeof zonedDayRange>, now: Date, label: string): ReportData {
  return {
    day,
    generatedAt: now,
    scopeLabel: label,
    summary: { incidents: 0, camerasAffected: 0, devicesAffected: 0, stillOffline: 0, totalDowntimeSeconds: 0 },
    locations: [],
    currentlyOffline: [],
    notMonitored: { recorders: 0, pendingNetwork: 0, cloudOnly: 0, disabled: 0, other: 0 },
  };
}

/** Builds the report for the local day (ALERT_TIMEZONE) containing `date`. storeIds null = all locations. */
export async function buildDailyReport(opts: DailyReportScope & { date: Date }): Promise<DailyReport> {
  const data = await buildDailyReportData(opts);
  const m = renderDailyReportEmail(data);
  return { subject: m.subject, text: m.text, html: m.html, summary: data.summary };
}

/**
 * Builds and queues the report for every active daily-report recipient. Default day: yesterday
 * in ALERT_TIMEZONE. Recipients scoped to stores get only their stores; one email per address.
 * All reports are built first and queued in one transaction, so a failure queues nothing.
 */
export async function sendDailyReportNow(opts?: { date?: Date }): Promise<{ recipients: number }> {
  const now = new Date();
  const date = opts?.date ?? previousDayRange(now, env.ALERT_TIMEZONE).start;
  const rows = await db
    .select({ email: alertRecipients.email, storeId: alertRecipients.storeId })
    .from(alertRecipients)
    .where(and(eq(alertRecipients.isActive, true), eq(alertRecipients.dailyReport, true)));

  const byEmail = new Map<string, { to: string; all: boolean; stores: Set<string> }>();
  for (const r of rows) {
    const key = r.email.trim().toLowerCase();
    if (!key) continue;
    const e = byEmail.get(key) ?? { to: r.email.trim(), all: false, stores: new Set<string>() };
    if (r.storeId == null) e.all = true;
    else e.stores.add(r.storeId);
    byEmail.set(key, e);
  }
  if (byEmail.size === 0) return { recipients: 0 };

  const cache = new Map<string, DailyReport>();
  const emails: OutgoingEmail[] = [];
  for (const r of byEmail.values()) {
    const storeIds = r.all ? null : [...r.stores].sort();
    const key = storeIds ? storeIds.join(",") : "*";
    let report = cache.get(key);
    if (!report) {
      const data = await buildDailyReportData({ date, storeIds, now });
      const m = renderDailyReportEmail(data);
      report = { subject: m.subject, text: m.text, html: m.html, summary: data.summary };
      cache.set(key, report);
    }
    emails.push({ kind: "DAILY_REPORT", to: r.to, subject: report.subject, text: report.text, html: report.html });
  }

  await db.transaction(async (tx) => {
    await queueEmails(emails, tx);
  });
  return { recipients: emails.length };
}

/**
 * Scheduler hook, called every minute: sends yesterday's report once per local day as soon as
 * the local hour reaches dailyReportHour. The day is claimed in vms.settings
 * ("alerts.lastDailyReportDate") with a conditional upsert before sending, so restarts and
 * concurrent processes never double-send; a missed slot (server down at that hour) is sent
 * on the next tick. If building/queueing fails, the claim is released for a later retry.
 */
export async function runDailyReportIfDue(now: Date = new Date()): Promise<{ sent: boolean; recipients: number; day?: string }> {
  const s = await getAlertSettings();
  if (!s.dailyReportEnabled) return { sent: false, recipients: 0 };
  const tz = env.ALERT_TIMEZONE;
  if (zonedParts(now, tz).hour < s.dailyReportHour) return { sent: false, recipients: 0 };
  const today = zonedDateKey(now, tz);

  const [prev] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, LAST_SENT_KEY));
  if (prev?.value === today) return { sent: false, recipients: 0 };

  const claimed = await db
    .insert(settings)
    .values({ key: LAST_SENT_KEY, value: today })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value`, updatedAt: new Date() }, setWhere: sql`${settings.value} <> excluded.value` })
    .returning({ key: settings.key });
  if (claimed.length === 0) return { sent: false, recipients: 0 };

  const yesterday = previousDayRange(now, tz);
  try {
    const { recipients } = await sendDailyReportNow({ date: yesterday.start });
    return { sent: true, recipients, day: yesterday.key };
  } catch (e) {
    // Nothing was queued (single transaction): release the claim so a later tick retries.
    try {
      if (prev) await db.update(settings).set({ value: prev.value, updatedAt: new Date() }).where(and(eq(settings.key, LAST_SENT_KEY), eq(settings.value, today)));
      else await db.delete(settings).where(and(eq(settings.key, LAST_SENT_KEY), eq(settings.value, today)));
    } catch {
      // Keep the claim: better to miss one report than to risk sending it twice.
    }
    throw e;
  }
}
