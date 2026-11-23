import "server-only";
import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, cameras, devices, type AuditLog } from "@/db/schema";
import { cameraScopeFilter } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";

export interface AuditFilter {
  page?: number;
  pageSize?: number;
  action?: string | null;
  actor?: string | null;
  entityType?: string | null;
  search?: string | null;
  from?: Date | null;
  to?: Date | null;
}

export interface AuditPage {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Audit visibility. Admins see everything. Everyone else (managers hold audit.view) sees their own
 * actions plus entries about entities inside their scope, resolved against the current tables:
 * their stores, recorders of those stores, and cameras they may see (camera-level grants apply).
 * Entries about deleted entities, users or the system are therefore only visible to their actor.
 */
function viewerScope(user: Pick<SessionUser, "id" | "isAdmin" | "storeIds" | "cameraScope">): SQL | undefined {
  if (user.isAdmin) return undefined;
  const own = eq(auditLogs.actorId, user.id);
  if (user.storeIds.length === 0) return own;
  const visibleCameras = db
    .select({ id: sql<string>`${cameras.id}::text` })
    .from(cameras)
    .where(cameraScopeFilter(user));
  const storeDevices = db
    .select({ id: sql<string>`${devices.id}::text` })
    .from(devices)
    .where(inArray(devices.storeId, user.storeIds));
  return or(
    own,
    and(eq(auditLogs.entityType, "store"), inArray(auditLogs.entityId, user.storeIds)),
    and(eq(auditLogs.entityType, "device"), inArray(auditLogs.entityId, storeDevices)),
    and(eq(auditLogs.entityType, "camera"), inArray(auditLogs.entityId, visibleCameras)),
  );
}

function buildWhere(f: AuditFilter, user: Pick<SessionUser, "id" | "isAdmin" | "storeIds" | "cameraScope">): SQL | undefined {
  const conditions: SQL[] = [];
  const scope = viewerScope(user);
  if (scope) conditions.push(scope);
  if (f.action) conditions.push(eq(auditLogs.action, f.action));
  if (f.actor) conditions.push(ilike(auditLogs.actorEmail, `%${f.actor}%`));
  if (f.entityType) conditions.push(eq(auditLogs.entityType, f.entityType));
  if (f.from) conditions.push(gte(auditLogs.createdAt, f.from));
  if (f.to) conditions.push(lte(auditLogs.createdAt, f.to));
  if (f.search) {
    const q = `%${f.search}%`;
    const s = or(ilike(auditLogs.entityLabel, q), ilike(auditLogs.details, q), ilike(auditLogs.actorEmail, q), ilike(auditLogs.ip, q));
    if (s) conditions.push(s);
  }
  return conditions.length ? and(...conditions) : undefined;
}

export async function listAuditLogs(user: SessionUser, f: AuditFilter = {}): Promise<AuditPage> {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, f.pageSize ?? 50));
  const where = buildWhere(f, user);
  const [items, totalRow] = await Promise.all([
    db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: count() }).from(auditLogs).where(where),
  ]);
  const total = Number(totalRow[0]?.n ?? 0);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Streams every matching row (used by CSV export); capped to protect the server. */
export async function exportAuditLogs(user: SessionUser, f: AuditFilter = {}, cap = 50_000): Promise<AuditLog[]> {
  return db.select().from(auditLogs).where(buildWhere(f, user)).orderBy(desc(auditLogs.createdAt)).limit(cap);
}

export async function distinctAuditActions(): Promise<string[]> {
  const rows = await db.select({ action: auditLogs.action }).from(auditLogs).groupBy(auditLogs.action).orderBy(auditLogs.action);
  return rows.map((r) => r.action);
}

export async function recentAuditLogs(limit = 10): Promise<AuditLog[]> {
  return db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(limit);
}

export async function auditCountSince(since: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLogs).where(gte(auditLogs.createdAt, since));
  return Number(row?.n ?? 0);
}

export const loginFailuresSince = async (since: Date): Promise<number> => {
  const [row] = await db
    .select({ n: count() })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "auth.login_failed"), gte(auditLogs.createdAt, since)));
  return Number(row?.n ?? 0);
};

export const activeUsersSince = async (since: Date): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${auditLogs.actorId})` })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "auth.login"), gte(auditLogs.createdAt, since)));
  return Number(row?.n ?? 0);
};
