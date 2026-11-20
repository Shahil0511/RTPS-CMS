import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { SCHEMA_NAME, type CameraStatus } from "@/db/schema";

/**
 * Availability over time, derived from status-change events (exact, no sampling).
 * Works for cameras and recorders with two queries regardless of entity count.
 */

export interface AvailabilityPoint {
  /** Bucket start (ISO). */
  at: string;
  /** Share of known time the entities were ONLINE in this bucket, 0-100, or null when nothing was known. */
  pct: number | null;
}

export interface AvailabilityResult {
  series: AvailabilityPoint[];
  /** Whole-window availability per entity (0-100 or null). */
  perEntity: Map<string, number | null>;
  /** Whole-window availability across all entities. */
  overall: number | null;
}

const TABLES = {
  camera: { table: "camera_status_events", key: "camera_id" },
  device: { table: "device_status_events", key: "device_id" },
} as const;

export async function availability(kind: keyof typeof TABLES, ids: string[], since: Date, until: Date, bucketMs: number): Promise<AvailabilityResult> {
  const buckets = Math.max(1, Math.ceil((until.getTime() - since.getTime()) / bucketMs));
  const empty: AvailabilityResult = {
    series: Array.from({ length: buckets }, (_, i) => ({ at: new Date(since.getTime() + i * bucketMs).toISOString(), pct: null })),
    perEntity: new Map(ids.map((id) => [id, null])),
    overall: null,
  };
  if (ids.length === 0) return empty;

  const { table, key } = TABLES[kind];
  const qualified = sql.raw(`"${SCHEMA_NAME}"."${table}"`);
  const keyCol = sql.raw(`"${key}"`);
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const [baselineRes, eventsRes] = await Promise.all([
    db.execute(
      sql`select distinct on (${keyCol}) ${keyCol}::text as id, status::text as status from ${qualified}
          where ${keyCol} in (${idList}) and created_at < ${since.toISOString()}::timestamptz
          order by ${keyCol}, created_at desc`,
    ),
    db.execute(
      sql`select ${keyCol}::text as id, status::text as status, created_at from ${qualified}
          where ${keyCol} in (${idList}) and created_at >= ${since.toISOString()}::timestamptz and created_at < ${until.toISOString()}::timestamptz
          order by ${keyCol}, created_at`,
    ),
  ]);

  const baseline = new Map<string, CameraStatus>();
  for (const r of baselineRes.rows as Array<{ id: string; status: CameraStatus }>) baseline.set(r.id, r.status);
  const events = new Map<string, Array<{ t: number; status: CameraStatus }>>();
  for (const r of eventsRes.rows as Array<{ id: string; status: CameraStatus; created_at: string | Date }>) {
    const list = events.get(r.id) ?? [];
    list.push({ t: new Date(r.created_at).getTime(), status: r.status });
    events.set(r.id, list);
  }

  const onlineMs = new Float64Array(buckets);
  const knownMs = new Float64Array(buckets);
  const start = since.getTime();
  const end = until.getTime();
  const perEntity = new Map<string, number | null>();
  let totalOnline = 0;
  let totalKnown = 0;

  // Adds an interval [a, b) with a given status to the bucket accumulators.
  const add = (a: number, b: number, status: CameraStatus, acc: { on: number; known: number }) => {
    if (b <= a || status === "UNKNOWN") return;
    acc.known += b - a;
    if (status === "ONLINE") acc.on += b - a;
    let cursor = a;
    while (cursor < b) {
      const i = Math.min(buckets - 1, Math.floor((cursor - start) / bucketMs));
      const bucketEnd = Math.min(b, start + (i + 1) * bucketMs);
      const span = bucketEnd - cursor;
      knownMs[i] = (knownMs[i] ?? 0) + span;
      if (status === "ONLINE") onlineMs[i] = (onlineMs[i] ?? 0) + span;
      cursor = bucketEnd;
    }
  };

  for (const id of ids) {
    const acc = { on: 0, known: 0 };
    let status: CameraStatus = baseline.get(id) ?? "UNKNOWN";
    let cursor = start;
    for (const e of events.get(id) ?? []) {
      add(cursor, Math.min(e.t, end), status, acc);
      status = e.status;
      cursor = Math.max(cursor, e.t);
    }
    add(cursor, end, status, acc);
    perEntity.set(id, acc.known > 0 ? round1((acc.on / acc.known) * 100) : null);
    totalOnline += acc.on;
    totalKnown += acc.known;
  }

  return {
    series: empty.series.map((p, i) => ({ at: p.at, pct: (knownMs[i] ?? 0) > 0 ? round1(((onlineMs[i] ?? 0) / (knownMs[i] ?? 1)) * 100) : null })),
    perEntity,
    overall: totalKnown > 0 ? round1((totalOnline / totalKnown) * 100) : null,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
