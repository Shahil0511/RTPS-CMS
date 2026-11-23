import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";

export interface AlertSettings {
  /** Minutes an entity must stay offline before an OFFLINE email goes out (suppresses flapping). */
  offlineGraceMinutes: number;
  /** Hour of day (0-23, ALERT_TIMEZONE) when the daily health report is sent. */
  dailyReportHour: number;
  dailyReportEnabled: boolean;
  /** Master switch for offline/online emails. */
  alertsEnabled: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  offlineGraceMinutes: 3,
  dailyReportHour: 9,
  dailyReportEnabled: true,
  alertsEnabled: true,
};

const KEYS = {
  offlineGraceMinutes: "alerts.offlineGraceMinutes",
  dailyReportHour: "alerts.dailyReportHour",
  dailyReportEnabled: "alerts.dailyReportEnabled",
  alertsEnabled: "alerts.enabled",
} as const satisfies Record<keyof AlertSettings, string>;

function parseInt0(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

/** Reads the alert settings from vms.settings, falling back to defaults for missing or invalid values. */
export async function getAlertSettings(): Promise<AlertSettings> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, Object.values(KEYS)));
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const d = DEFAULT_ALERT_SETTINGS;
  return {
    offlineGraceMinutes: parseInt0(map.get(KEYS.offlineGraceMinutes), d.offlineGraceMinutes, 0, 1440),
    dailyReportHour: parseInt0(map.get(KEYS.dailyReportHour), d.dailyReportHour, 0, 23),
    dailyReportEnabled: parseBool(map.get(KEYS.dailyReportEnabled), d.dailyReportEnabled),
    alertsEnabled: parseBool(map.get(KEYS.alertsEnabled), d.alertsEnabled),
  };
}

/** Upserts the given settings and returns the full, effective settings afterwards. */
export async function saveAlertSettings(partial: Partial<AlertSettings>): Promise<AlertSettings> {
  const values: { key: string; value: string }[] = [];
  if (partial.offlineGraceMinutes !== undefined) {
    values.push({ key: KEYS.offlineGraceMinutes, value: String(Math.min(1440, Math.max(0, Math.round(partial.offlineGraceMinutes)))) });
  }
  if (partial.dailyReportHour !== undefined) {
    values.push({ key: KEYS.dailyReportHour, value: String(Math.min(23, Math.max(0, Math.round(partial.dailyReportHour)))) });
  }
  if (partial.dailyReportEnabled !== undefined) values.push({ key: KEYS.dailyReportEnabled, value: String(partial.dailyReportEnabled) });
  if (partial.alertsEnabled !== undefined) values.push({ key: KEYS.alertsEnabled, value: String(partial.alertsEnabled) });

  if (values.length > 0) {
    await db
      .insert(settings)
      .values(values)
      .onConflictDoUpdate({ target: settings.key, set: { value: sql`excluded.value`, updatedAt: new Date() } });
  }
  return getAlertSettings();
}
