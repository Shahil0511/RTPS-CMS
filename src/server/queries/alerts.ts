import "server-only";
import { and, asc, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { alertRecipients, emailOutbox, stores, type EmailKind, type EmailStatus } from "@/db/schema";

export interface RecipientRow {
  id: string;
  name: string | null;
  email: string;
  storeId: string | null;
  storeName: string | null;
  storeCode: string | null;
  onOffline: boolean;
  onOnline: boolean;
  dailyReport: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Alert recipients, "All locations" entries first, then by store and email. */
export async function listRecipients(): Promise<RecipientRow[]> {
  return db
    .select({
      id: alertRecipients.id,
      name: alertRecipients.name,
      email: alertRecipients.email,
      storeId: alertRecipients.storeId,
      storeName: stores.name,
      storeCode: stores.code,
      onOffline: alertRecipients.onOffline,
      onOnline: alertRecipients.onOnline,
      dailyReport: alertRecipients.dailyReport,
      isActive: alertRecipients.isActive,
      createdAt: alertRecipients.createdAt,
      updatedAt: alertRecipients.updatedAt,
    })
    .from(alertRecipients)
    .leftJoin(stores, eq(stores.id, alertRecipients.storeId))
    .orderBy(sql`${alertRecipients.storeId} is not null`, asc(stores.name), asc(alertRecipients.email));
}

export interface StoreEmailSuggestion {
  storeId: string;
  storeName: string;
  storeCode: string;
  email: string;
  /** True when a recipient with this email already exists for this store. */
  alreadyAdded: boolean;
}

/** Store mailboxes (stores.email) that could become per-location recipients. */
export async function storeEmailSuggestions(): Promise<StoreEmailSuggestion[]> {
  const rows = await db
    .select({
      storeId: stores.id,
      storeName: stores.name,
      storeCode: stores.code,
      email: sql<string>`trim(${stores.email})`,
      alreadyAdded: sql<boolean>`exists (
        select 1 from ${alertRecipients} ar
        where ar.store_id = ${stores.id} and lower(ar.email) = lower(trim(${stores.email}))
      )`,
    })
    .from(stores)
    .where(and(isNotNull(stores.email), ne(sql`trim(${stores.email})`, ""), eq(stores.isActive, true)))
    .orderBy(asc(stores.name));
  return rows.map((r) => ({ ...r, alreadyAdded: Boolean(r.alreadyAdded) }));
}

export interface OutboxRow {
  id: number;
  kind: EmailKind;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

/** Most recent outbox entries without their bodies (those are loaded on demand). */
export async function listOutbox(limit = 100): Promise<OutboxRow[]> {
  return db
    .select({
      id: emailOutbox.id,
      kind: emailOutbox.kind,
      toAddress: emailOutbox.toAddress,
      subject: emailOutbox.subject,
      status: emailOutbox.status,
      attempts: emailOutbox.attempts,
      lastError: emailOutbox.lastError,
      createdAt: emailOutbox.createdAt,
      sentAt: emailOutbox.sentAt,
    })
    .from(emailOutbox)
    .orderBy(desc(emailOutbox.createdAt), desc(emailOutbox.id))
    .limit(Math.min(500, Math.max(1, limit)));
}

export async function getOutboxMessage(id: number): Promise<{ subject: string; toAddress: string; bodyHtml: string; bodyText: string; kind: EmailKind } | null> {
  const [row] = await db
    .select({ subject: emailOutbox.subject, toAddress: emailOutbox.toAddress, bodyHtml: emailOutbox.bodyHtml, bodyText: emailOutbox.bodyText, kind: emailOutbox.kind })
    .from(emailOutbox)
    .where(eq(emailOutbox.id, id))
    .limit(1);
  return row ?? null;
}

export type OutboxStats = Record<EmailStatus, number>;

/** Outbox totals by status since the given time. */
export async function outboxStatsSince(since: Date): Promise<OutboxStats> {
  const rows = await db
    .select({ status: emailOutbox.status, n: sql<number>`count(*)` })
    .from(emailOutbox)
    .where(gte(emailOutbox.createdAt, since))
    .groupBy(emailOutbox.status);
  const out: OutboxStats = { QUEUED: 0, SENDING: 0, SENT: 0, FAILED: 0, SKIPPED_NO_SMTP: 0 };
  for (const r of rows) if (r.status in out) out[r.status] = Number(r.n);
  return out;
}

export interface RecipientSummary {
  total: number;
  active: number;
  offline: number;
  online: number;
  daily: number;
}

export async function recipientSummary(): Promise<RecipientSummary> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      active: sql<number>`count(*) filter (where ${alertRecipients.isActive})`,
      offline: sql<number>`count(*) filter (where ${alertRecipients.isActive} and ${alertRecipients.onOffline})`,
      online: sql<number>`count(*) filter (where ${alertRecipients.isActive} and ${alertRecipients.onOnline})`,
      daily: sql<number>`count(*) filter (where ${alertRecipients.isActive} and ${alertRecipients.dailyReport})`,
    })
    .from(alertRecipients);
  return {
    total: Number(row?.total ?? 0),
    active: Number(row?.active ?? 0),
    offline: Number(row?.offline ?? 0),
    online: Number(row?.online ?? 0),
    daily: Number(row?.daily ?? 0),
  };
}
