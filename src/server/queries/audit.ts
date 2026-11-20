import "server-only";
import { and, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, type AuditLog } from "@/db/schema";

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

function buildWhere(f: AuditFilter): SQL | undefined {
  const conditions: SQL[] = [];
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

export async function listAuditLogs(f: AuditFilter = {}): Promise<AuditPage> {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, f.pageSize ?? 50));
  const where = buildWhere(f);
  const [items, totalRow] = await Promise.all([
    db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: count() }).from(auditLogs).where(where),
  ]);
  const total = Number(totalRow[0]?.n ?? 0);
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Streams every matching row (used by CSV export); capped to protect the server. */
export async function exportAuditLogs(f: AuditFilter = {}, cap = 50_000): Promise<AuditLog[]> {
  return db.select().from(auditLogs).where(buildWhere(f)).orderBy(desc(auditLogs.createdAt)).limit(cap);
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
