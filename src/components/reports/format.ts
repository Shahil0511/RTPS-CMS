/**
 * Timezone-aware date helpers for alerts and downtime reports (safe for client and server).
 * Every time in these screens is shown in the alert timezone (Asia/Kolkata by default),
 * whatever the viewer's browser is set to.
 */

export const DEFAULT_TZ = "Asia/Kolkata";

type DateLike = Date | string | number | null | undefined;

function toDate(value: DateLike): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "23 Nov 2026, 14:05" in the given timezone. */
export function formatZoned(value: DateLike, tz: string = DEFAULT_TZ, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleString("en-IN", { timeZone: tz, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, ...opts });
}

/** "14:05:09" in the given timezone. */
export function formatZonedTime(value: DateLike, tz: string = DEFAULT_TZ): string {
  const d = toDate(value);
  if (!d) return "—";
  return d.toLocaleTimeString("en-IN", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** "Mon, 23 Nov 2026" for a YYYY-MM-DD day key. */
export function formatDayKey(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-IN", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

/** Compact duration: "2d 4h", "3h 07m", "12m 05s", "40s". */
export function formatDurationShort(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "0s";
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${r.toString().padStart(2, "0")}s`;
  return `${r}s`;
}

/** Milliseconds the timezone is ahead of UTC at the given instant. */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** YYYY-MM-DD of the given instant in the timezone. */
export function dayKeyInTz(at: Date, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function isDayKey(v: string | null | undefined): v is string {
  return Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()));
}

/** Adds whole days to a YYYY-MM-DD key. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The UTC instant of 00:00 on the given day in the timezone. */
export function startOfDayInTz(day: string, tz: string = DEFAULT_TZ): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let result = guess - tzOffsetMs(new Date(guess), tz);
  // Re-check once in case the offset differs at the real instant (DST zones).
  const second = guess - tzOffsetMs(new Date(result), tz);
  if (second !== result) result = second;
  return new Date(result);
}

/** Noon of the given day in the timezone: an instant that is unambiguously "on" that day. */
export function middayInTz(day: string, tz: string = DEFAULT_TZ): Date {
  return new Date(startOfDayInTz(day, tz).getTime() + 12 * 3600 * 1000);
}

export const RANGE_PRESETS = ["today", "yesterday", "7d", "30d", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_LABELS: Record<RangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  custom: "Custom",
};

export interface ResolvedRange {
  preset: RangePreset;
  /** Inclusive first day (YYYY-MM-DD, timezone-local). */
  fromDay: string;
  /** Inclusive last day. */
  toDay: string;
  from: Date;
  /** Exclusive end instant (start of the day after toDay, capped at now for display only by callers). */
  to: Date;
  label: string;
}

/** Turns a preset or custom day range into UTC instants for the given timezone. */
export function resolveRange(preset: string | undefined, fromRaw: string | undefined, toRaw: string | undefined, tz: string = DEFAULT_TZ, now = new Date()): ResolvedRange {
  const today = dayKeyInTz(now, tz);
  const p: RangePreset = (RANGE_PRESETS as readonly string[]).includes(preset ?? "") ? (preset as RangePreset) : isDayKey(fromRaw) || isDayKey(toRaw) ? "custom" : "7d";
  let fromDay = today;
  let toDay = today;
  if (p === "yesterday") fromDay = toDay = addDays(today, -1);
  else if (p === "7d") fromDay = addDays(today, -6);
  else if (p === "30d") fromDay = addDays(today, -29);
  else if (p === "custom") {
    fromDay = isDayKey(fromRaw) ? fromRaw : isDayKey(toRaw) ? toRaw : addDays(today, -6);
    toDay = isDayKey(toRaw) ? toRaw : today;
    if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay];
    // Keep custom ranges bounded so a typo cannot scan years of history.
    if (addDays(fromDay, 366) < toDay) fromDay = addDays(toDay, -366);
  }
  const label = fromDay === toDay ? formatDayKey(fromDay) : `${formatDayKey(fromDay)} – ${formatDayKey(toDay)}`;
  return { preset: p, fromDay, toDay, from: startOfDayInTz(fromDay, tz), to: startOfDayInTz(addDays(toDay, 1), tz), label };
}
