/**
 * Timezone helpers for alerts and reports. Pure functions (no server dependencies),
 * so UI code can reuse them for the same formatting as the emails.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partFormatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in the given IANA timezone. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Offset of the timezone from UTC at that instant, in milliseconds (IST = +19800000). */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant of local midnight on the given calendar date in the timezone. */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day);
  let t = guess - tzOffsetMs(new Date(guess), timeZone);
  // Second pass settles DST changes between the guess and the answer.
  t = guess - tzOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

/** YYYY-MM-DD of the local calendar day containing the instant. */
export function zonedDateKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export interface DayRange {
  start: Date;
  /** Exclusive: the next local midnight. */
  end: Date;
  /** YYYY-MM-DD */
  key: string;
  /** "22 Nov 2026" */
  label: string;
}

/** Local calendar day (in the timezone) that contains the instant. */
export function zonedDayRange(date: Date, timeZone: string): DayRange {
  const p = zonedParts(date, timeZone);
  const start = zonedMidnight(p.year, p.month, p.day, timeZone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone);
  return {
    start,
    end,
    key: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
    label: `${String(p.day).padStart(2, "0")} ${MONTHS[p.month - 1]} ${p.year}`,
  };
}

/** The local calendar day before the one containing `now`. */
export function previousDayRange(now: Date, timeZone: string): DayRange {
  const today = zonedDayRange(now, timeZone);
  return zonedDayRange(new Date(today.start.getTime() - 12 * 3600 * 1000), timeZone);
}

/** Short zone label: "IST" for India, otherwise what Intl offers (e.g. "GMT+4"). */
export function zoneAbbrev(timeZone: string, at: Date = new Date()): string {
  if (timeZone === "Asia/Kolkata" || timeZone === "Asia/Calcutta") return "IST";
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName");
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** "23 Nov 2026, 14:05 IST" */
export function formatInZone(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${String(p.day).padStart(2, "0")} ${MONTHS[p.month - 1]} ${p.year}, ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ${zoneAbbrev(timeZone, date)}`;
}

/** "14:05" in the timezone. */
export function formatTimeInZone(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Human downtime: "45s", "12m", "1h 12m", "2d 3h". */
export function formatDowntime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}
