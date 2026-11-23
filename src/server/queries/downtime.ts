import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { cameras, devices, downtimeIncidents, stores, userCameras, userStores, type ConnectionMode, type DowntimeEntityType } from "@/db/schema";
import { storeScope } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";

/**
 * Downtime reports read from vms.downtime_incidents (one row per offline period).
 *
 * Visibility: admins see everything. Other users see incidents of their assigned stores; when
 * a store is camera-limited for them (vms.user_stores.camera_limited), camera incidents of that
 * store are limited to their granted cameras (vms.user_cameras, possibly none). Recorder
 * incidents stay visible for the whole store.
 */

export interface DowntimeScope {
  /** null = all stores. */
  storeIds: string[] | null;
  /** Set for non-admins so per-camera grants apply. */
  userId: string | null;
}

export function downtimeScopeFor(user: SessionUser): DowntimeScope {
  const storeIds = storeScope(user);
  return { storeIds, userId: storeIds ? user.id : null };
}

export interface DowntimeFilter {
  /** Range start (inclusive). Incidents overlapping [from, to) are included. */
  from: Date;
  /** Range end (exclusive). */
  to: Date;
  storeId?: string | null;
  entityType?: DowntimeEntityType | null;
  status?: "open" | "closed" | null;
  search?: string | null;
}

const di = downtimeIncidents;

function scopeCondition(scope: DowntimeScope): SQL | undefined {
  if (!scope.storeIds) return undefined;
  if (scope.storeIds.length === 0) return sql`false`;
  const uid = scope.userId;
  const inStores = inArray(di.storeId, scope.storeIds);
  if (!uid) return inStores;
  // Camera incidents: allowed when the store is not camera-limited for the user, or they hold a grant for this camera.
  const cameraOk = sql`(
    ${di.entityType} <> 'CAMERA'
    or ${di.cameraId} is null
    or not exists (
      select 1 from ${userStores} us
      where us.user_id = ${uid} and us.store_id = ${di.storeId} and us.camera_limited
    )
    or exists (select 1 from ${userCameras} uc2 where uc2.user_id = ${uid} and uc2.camera_id = ${di.cameraId})
  )`;
  return and(inStores, cameraOk);
}

function overlapCondition(from: Date, to: Date): SQL {
  return and(lt(di.startedAt, to), or(isNull(di.endedAt), sql`${di.endedAt} >= ${from}`)) as SQL;
}

function filterConditions(scope: DowntimeScope, f: DowntimeFilter, opts: { range?: boolean } = {}): SQL[] {
  const conditions: SQL[] = [];
  const s = scopeCondition(scope);
  if (s) conditions.push(s);
  if (opts.range !== false) conditions.push(overlapCondition(f.from, f.to));
  if (f.storeId) conditions.push(eq(di.storeId, f.storeId));
  if (f.entityType) conditions.push(eq(di.entityType, f.entityType));
  if (f.status === "open") conditions.push(isNull(di.endedAt));
  if (f.status === "closed") conditions.push(isNotNull(di.endedAt));
  if (f.search?.trim()) {
    const q = `%${f.search.trim()}%`;
    const m = or(ilike(di.entityName, q), ilike(di.storeName, q), ilike(di.startDetail, q), ilike(devices.name, q), ilike(stores.name, q), ilike(stores.code, q));
    if (m) conditions.push(m);
  }
  return conditions;
}

/** Seconds of the incident that fall inside [from, to), with open incidents counted up to now. */
function clippedSeconds(from: Date, to: Date): SQL<number> {
  return sql<number>`greatest(0, extract(epoch from (least(coalesce(${di.endedAt}, now()), ${to}::timestamptz) - greatest(${di.startedAt}, ${from}::timestamptz))))`;
}

/** Recorder that owns the incident: the incident's own device, or the camera's recorder. */
const recorderJoin = sql`${devices.id} = coalesce(${di.deviceId}, ${cameras.deviceId})`;

export interface DowntimeKpis {
  incidents: number;
  totalDowntimeSeconds: number;
  camerasAffected: number;
  recordersAffected: number;
  /** Open incidents right now (not limited to the date range). */
  currentlyOffline: number;
  currentlyOfflineCameras: number;
  currentlyOfflineRecorders: number;
  /** Mean time to recover over incidents that closed, in seconds. Null when none closed. */
  mttrSeconds: number | null;
  alertsSent: number;
}

export async function downtimeKpis(scope: DowntimeScope, f: DowntimeFilter): Promise<DowntimeKpis> {
  const where = and(...filterConditions(scope, f));
  const openWhere = and(...filterConditions(scope, { ...f, status: "open", search: null }, { range: false }));
  const [[row], [open]] = await Promise.all([
    db
      .select({
        incidents: sql<number>`count(*)`,
        total: sql<number>`coalesce(sum(${clippedSeconds(f.from, f.to)}), 0)`,
        cams: sql<number>`count(distinct ${di.cameraId}) filter (where ${di.entityType} = 'CAMERA')`,
        recs: sql<number>`count(distinct ${di.deviceId}) filter (where ${di.entityType} = 'DEVICE')`,
        mttr: sql<number | null>`avg(${di.durationSeconds}) filter (where ${di.endedAt} is not null)`,
        alerts: sql<number>`count(*) filter (where ${di.downAlertedAt} is not null and not ${di.backfilled})`,
      })
      .from(di)
      .leftJoin(cameras, eq(cameras.id, di.cameraId))
      .leftJoin(devices, recorderJoin)
      .leftJoin(stores, eq(stores.id, di.storeId))
      .where(where),
    db
      .select({
        total: sql<number>`count(*)`,
        cams: sql<number>`count(*) filter (where ${di.entityType} = 'CAMERA')`,
        recs: sql<number>`count(*) filter (where ${di.entityType} = 'DEVICE')`,
      })
      .from(di)
      .where(openWhere),
  ]);
  return {
    incidents: Number(row?.incidents ?? 0),
    totalDowntimeSeconds: Math.round(Number(row?.total ?? 0)),
    camerasAffected: Number(row?.cams ?? 0),
    recordersAffected: Number(row?.recs ?? 0),
    currentlyOffline: Number(open?.total ?? 0),
    currentlyOfflineCameras: Number(open?.cams ?? 0),
    currentlyOfflineRecorders: Number(open?.recs ?? 0),
    mttrSeconds: row?.mttr === null || row?.mttr === undefined ? null : Math.round(Number(row.mttr)),
    alertsSent: Number(row?.alerts ?? 0),
  };
}

export interface DowntimeRow {
  id: number;
  entityType: DowntimeEntityType;
  entityName: string;
  cameraId: string | null;
  deviceId: string | null;
  storeId: string | null;
  storeName: string | null;
  storeCode: string | null;
  recorderName: string | null;
  channel: number | null;
  startedAt: Date;
  endedAt: Date | null;
  /** Stored duration for closed incidents; live (until now) for open ones. */
  durationSeconds: number;
  startDetail: string | null;
  endDetail: string | null;
  parentIncidentId: number | null;
  /** Null for backfilled incidents (their alert columns only mean "handled, never emailed"). */
  downAlertedAt: Date | null;
  upAlertedAt: Date | null;
  /** Already offline before alerting could see it: logged, never emailed. */
  backfilled: boolean;
}

const rowColumns = {
  id: di.id,
  entityType: di.entityType,
  entityName: di.entityName,
  cameraId: di.cameraId,
  deviceId: di.deviceId,
  storeId: di.storeId,
  storeName: sql<string | null>`coalesce(${stores.name}, ${di.storeName})`,
  storeCode: stores.code,
  recorderName: sql<string | null>`case when ${di.entityType} = 'DEVICE' then coalesce(${devices.name}, ${di.entityName}) else ${devices.name} end`,
  channel: cameras.channel,
  startedAt: di.startedAt,
  endedAt: di.endedAt,
  durationSeconds: sql<number>`coalesce(${di.durationSeconds}, greatest(0, extract(epoch from (coalesce(${di.endedAt}, now()) - ${di.startedAt}))))::int`,
  startDetail: di.startDetail,
  endDetail: di.endDetail,
  parentIncidentId: di.parentIncidentId,
  downAlertedAt: sql<Date | null>`case when ${di.backfilled} then null else ${di.downAlertedAt} end`.mapWith(di.downAlertedAt),
  upAlertedAt: sql<Date | null>`case when ${di.backfilled} then null else ${di.upAlertedAt} end`.mapWith(di.upAlertedAt),
  backfilled: di.backfilled,
};

function baseQuery() {
  return db
    .select(rowColumns)
    .from(di)
    .leftJoin(cameras, eq(cameras.id, di.cameraId))
    .leftJoin(devices, recorderJoin)
    .leftJoin(stores, eq(stores.id, di.storeId));
}

function normalise(r: Awaited<ReturnType<ReturnType<typeof baseQuery>["execute"]>>[number]): DowntimeRow {
  return { ...r, durationSeconds: Number(r.durationSeconds ?? 0) };
}

export interface DowntimePage {
  items: DowntimeRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export async function listDowntime(scope: DowntimeScope, f: DowntimeFilter & { page?: number; pageSize?: number }): Promise<DowntimePage> {
  const pageSize = Math.min(200, Math.max(10, f.pageSize ?? 25));
  const where = and(...filterConditions(scope, f));
  const [[countRow]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(di)
      .leftJoin(cameras, eq(cameras.id, di.cameraId))
      .leftJoin(devices, recorderJoin)
      .leftJoin(stores, eq(stores.id, di.storeId))
      .where(where),
  ]);
  const total = Number(countRow?.n ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, f.page ?? 1));
  const rows = await baseQuery()
    .where(where)
    .orderBy(desc(di.startedAt), desc(di.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: rows.map(normalise), total, page, pageSize, pageCount };
}

/** Every matching row for CSV export, capped to protect the server. */
export async function exportDowntime(scope: DowntimeScope, f: DowntimeFilter, cap = 50_000): Promise<DowntimeRow[]> {
  const rows = await baseQuery()
    .where(and(...filterConditions(scope, f)))
    .orderBy(desc(di.startedAt), desc(di.id))
    .limit(cap);
  return rows.map(normalise);
}

/** Incidents that are still open (entity offline right now), oldest first. */
export async function listOpenIncidents(scope: DowntimeScope, opts: { storeId?: string | null; limit?: number } = {}): Promise<DowntimeRow[]> {
  const conditions: SQL[] = [isNull(di.endedAt)];
  const s = scopeCondition(scope);
  if (s) conditions.push(s);
  if (opts.storeId) conditions.push(eq(di.storeId, opts.storeId));
  const rows = await baseQuery()
    .where(and(...conditions))
    .orderBy(asc(di.startedAt))
    .limit(opts.limit ?? 100);
  return rows.map(normalise);
}

export interface UnstableCamera {
  cameraId: string;
  name: string;
  storeName: string | null;
  incidents: number;
  downtimeSeconds: number;
  lastStartedAt: Date;
  openNow: boolean;
}

/**
 * Cameras with the most offline incidents in the range. Incidents caused by the recorder being
 * down (parent incident) are excluded: they say nothing about the camera itself.
 */
export async function mostUnstableCameras(scope: DowntimeScope, f: DowntimeFilter, limit = 10): Promise<UnstableCamera[]> {
  const conditions = filterConditions(scope, { ...f, entityType: "CAMERA", status: null, search: null });
  conditions.push(isNotNull(di.cameraId), isNull(di.parentIncidentId));
  const incidents = sql<number>`count(*)`;
  const downtime = sql<number>`coalesce(sum(${clippedSeconds(f.from, f.to)}), 0)`;
  const rows = await db
    .select({
      cameraId: sql<string>`${di.cameraId}`,
      name: sql<string>`max(${di.entityName})`,
      storeName: sql<string | null>`max(coalesce(${stores.name}, ${di.storeName}))`,
      incidents,
      downtimeSeconds: downtime,
      lastStartedAt: sql<Date>`max(${di.startedAt})`,
      openNow: sql<boolean>`bool_or(${di.endedAt} is null)`,
    })
    .from(di)
    .leftJoin(stores, eq(stores.id, di.storeId))
    .where(and(...conditions))
    .groupBy(di.cameraId)
    .orderBy(desc(incidents), desc(downtime))
    .limit(limit);
  return rows.map((r) => ({
    cameraId: r.cameraId,
    name: r.name,
    storeName: r.storeName,
    incidents: Number(r.incidents),
    downtimeSeconds: Math.round(Number(r.downtimeSeconds)),
    lastStartedAt: r.lastStartedAt instanceof Date ? r.lastStartedAt : new Date(r.lastStartedAt),
    openNow: Boolean(r.openNow),
  }));
}

export interface CoverageRow {
  mode: ConnectionMode;
  recorders: number;
  cameras: number;
}

/** How many recorders (and their cameras) are in each connection mode: only Live ones are monitored. */
export async function monitoringCoverage(scope: DowntimeScope, storeId?: string | null): Promise<CoverageRow[]> {
  if (scope.storeIds && scope.storeIds.length === 0) return [];
  const conditions: SQL[] = [];
  if (scope.storeIds) conditions.push(inArray(devices.storeId, scope.storeIds));
  if (storeId) conditions.push(eq(devices.storeId, storeId));
  const rows = await db
    .select({
      mode: devices.connectionMode,
      recorders: sql<number>`count(distinct ${devices.id})`,
      cameras: sql<number>`count(${cameras.id})`,
    })
    .from(devices)
    .leftJoin(cameras, eq(cameras.deviceId, devices.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(devices.connectionMode);
  return rows.map((r) => ({ mode: r.mode, recorders: Number(r.recorders), cameras: Number(r.cameras) }));
}

/** Earliest incident on record, so the UI can say how far history goes back. */
export async function firstIncidentAt(scope: DowntimeScope): Promise<Date | null> {
  const s = scopeCondition(scope);
  const [row] = await db
    .select({ at: sql<Date | null>`min(${di.startedAt})` })
    .from(di)
    .where(s);
  if (!row?.at) return null;
  return row.at instanceof Date ? row.at : new Date(row.at);
}
