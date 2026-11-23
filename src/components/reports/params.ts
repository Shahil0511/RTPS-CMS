import { resolveRange, type ResolvedRange } from "./format";

/**
 * Query-string contract shared by the /reports page and /api/reports/downtime.csv so the
 * export always matches what is on screen. Safe for client and server.
 */

export interface ReportSearch {
  range?: string;
  from?: string;
  to?: string;
  store?: string;
  type?: string;
  status?: string;
  q?: string;
  page?: string;
  day?: string;
}

export const REPORT_PARAM_KEYS = ["range", "from", "to", "store", "type", "status", "q", "page", "day"] as const satisfies ReadonlyArray<keyof ReportSearch>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedReportFilter {
  range: ResolvedRange;
  storeId: string | null;
  entityType: "CAMERA" | "DEVICE" | null;
  status: "open" | "closed" | null;
  search: string | null;
  page: number;
}

function first(v: string | string[] | undefined | null): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

/** Normalises raw search params (page props or URLSearchParams) into a typed filter. */
export function parseReportSearch(raw: Record<string, string | string[] | undefined> | URLSearchParams, tz: string): ParsedReportFilter {
  const get = (k: keyof ReportSearch): string | undefined => (raw instanceof URLSearchParams ? (raw.get(k) ?? undefined) : first(raw[k]));
  const store = get("store")?.trim();
  const type = get("type")?.toUpperCase();
  const status = get("status")?.toLowerCase();
  const q = get("q")?.trim().slice(0, 120);
  const page = Number.parseInt(get("page") ?? "1", 10);
  return {
    range: resolveRange(get("range"), get("from"), get("to"), tz),
    storeId: store && UUID.test(store) ? store : null,
    entityType: type === "CAMERA" || type === "DEVICE" ? type : null,
    status: status === "open" || status === "closed" ? status : null,
    search: q ? q : null,
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Builds a query string from the current params, overriding/removing keys (undefined or "" removes). */
export function reportQuery(current: ReportSearch, patch: Partial<Record<keyof ReportSearch, string | undefined>> = {}): string {
  const qs = new URLSearchParams();
  for (const k of REPORT_PARAM_KEYS) {
    const v = k in patch ? patch[k] : current[k];
    if (v) qs.set(k, v);
  }
  return qs.toString();
}

/** Flattens Next.js page searchParams into the ReportSearch shape (first value wins). */
export function toReportSearch(raw: Record<string, string | string[] | undefined>): ReportSearch {
  const out: ReportSearch = {};
  for (const k of REPORT_PARAM_KEYS) {
    const v = first(raw[k]);
    if (v) out[k] = v;
  }
  return out;
}
