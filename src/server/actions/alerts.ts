"use server";

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { alertRecipients, stores } from "@/db/schema";
import { audit } from "@/lib/audit";
import { flushOutbox, getMailerStatus, sendTestEmail } from "@/lib/alerts/mailer";
import { sendDailyReportNow } from "@/lib/alerts/reports";
import { saveAlertSettings } from "@/lib/alerts/settings";
import { rolesFor } from "@/lib/auth/rbac";
import { requestMeta, requireUser } from "@/lib/auth/session";
import { getOutboxMessage } from "@/server/queries/alerts";
import { checkbox, failure, optionalText, parseForm, success, type ActionState } from "../action-utils";

/** Alert recipients, alert settings and email outbox (administrators only). */

const storeIdField = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || z.uuid().safeParse(v).success, "Choose a valid location");

const recipientSchema = z.object({
  name: optionalText(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200),
  storeId: storeIdField,
  onOffline: checkbox,
  onOnline: checkbox,
  dailyReport: checkbox,
  isActive: checkbox,
});

function revalidate() {
  revalidatePath("/alerts");
  revalidatePath("/settings");
}

async function storeExists(storeId: string | null): Promise<{ ok: boolean; name: string | null }> {
  if (!storeId) return { ok: true, name: null };
  const s = await db.query.stores.findFirst({ where: eq(stores.id, storeId), columns: { id: true, name: true } });
  return { ok: Boolean(s), name: s?.name ?? null };
}

async function duplicateExists(email: string, storeId: string | null, exceptId?: string): Promise<boolean> {
  const conditions = [sql`lower(${alertRecipients.email}) = ${email.toLowerCase()}`, storeId ? eq(alertRecipients.storeId, storeId) : isNull(alertRecipients.storeId)];
  if (exceptId) conditions.push(ne(alertRecipients.id, exceptId));
  const row = await db.query.alertRecipients.findFirst({ where: and(...conditions), columns: { id: true } });
  return Boolean(row);
}

export async function createRecipientAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser(rolesFor("alerts.manage"));
  const parsed = parseForm(recipientSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;
  if (!d.onOffline && !d.onOnline && !d.dailyReport) return failure("Choose at least one kind of email for this recipient.");
  const store = await storeExists(d.storeId);
  if (!store.ok) return failure("Location not found.");
  if (await duplicateExists(d.email, d.storeId)) return failure("This email is already a recipient for that location.");

  const [row] = await db
    .insert(alertRecipients)
    .values({ name: d.name, email: d.email, storeId: d.storeId, onOffline: d.onOffline, onOnline: d.onOnline, dailyReport: d.dailyReport, isActive: d.isActive })
    .returning({ id: alertRecipients.id });
  if (!row) return failure("Could not add the recipient.");

  const meta = await requestMeta();
  await audit({
    actor,
    action: "alert.recipient_created",
    entityType: "system",
    entityId: row.id,
    entityLabel: d.email,
    details: { location: store.name ?? "All locations", offline: d.onOffline, online: d.onOnline, daily: d.dailyReport, active: d.isActive },
    ...meta,
  });
  revalidate();
  return success("Recipient added", { id: row.id });
}

export async function updateRecipientAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser(rolesFor("alerts.manage"));
  const id = String(formData.get("id") ?? "");
  if (!z.uuid().safeParse(id).success) return failure("Recipient not found.");
  const parsed = parseForm(recipientSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;
  if (!d.onOffline && !d.onOnline && !d.dailyReport) return failure("Choose at least one kind of email for this recipient.");

  const current = await db.query.alertRecipients.findFirst({ where: eq(alertRecipients.id, id) });
  if (!current) return failure("Recipient not found.");
  const store = await storeExists(d.storeId);
  if (!store.ok) return failure("Location not found.");
  if (await duplicateExists(d.email, d.storeId, id)) return failure("This email is already a recipient for that location.");

  await db
    .update(alertRecipients)
    .set({ name: d.name, email: d.email, storeId: d.storeId, onOffline: d.onOffline, onOnline: d.onOnline, dailyReport: d.dailyReport, isActive: d.isActive })
    .where(eq(alertRecipients.id, id));

  const meta = await requestMeta();
  await audit({
    actor,
    action: "alert.recipient_updated",
    entityType: "system",
    entityId: id,
    entityLabel: d.email,
    details: { location: store.name ?? "All locations", offline: d.onOffline, online: d.onOnline, daily: d.dailyReport, active: d.isActive, emailChanged: current.email !== d.email },
    ...meta,
  });
  revalidate();
  return success("Recipient updated");
}

export async function deleteRecipientAction(id: string): Promise<ActionState> {
  const actor = await requireUser(rolesFor("alerts.manage"));
  if (!z.uuid().safeParse(id).success) return failure("Recipient not found.");
  const current = await db.query.alertRecipients.findFirst({ where: eq(alertRecipients.id, id) });
  if (!current) return failure("Recipient not found.");
  await db.delete(alertRecipients).where(eq(alertRecipients.id, id));
  const meta = await requestMeta();
  await audit({ actor, action: "alert.recipient_deleted", entityType: "system", entityId: id, entityLabel: current.email, ...meta });
  revalidate();
  return success("Recipient removed");
}

/** Adds each selected store's mailbox (stores.email) as a recipient for that store. Existing ones are skipped. */
export async function addStoreRecipientsAction(storeIds: string[]): Promise<ActionState> {
  const actor = await requireUser(rolesFor("alerts.manage"));
  const ids = z.array(z.uuid()).max(500).safeParse(storeIds);
  if (!ids.success || ids.data.length === 0) return failure("Select at least one location.");

  const rows = await db.select({ id: stores.id, name: stores.name, email: stores.email }).from(stores).where(inArray(stores.id, ids.data));
  let added = 0;
  let skipped = 0;
  for (const s of rows) {
    const email = (s.email ?? "").trim().toLowerCase();
    if (!z.email().safeParse(email).success || (await duplicateExists(email, s.id))) {
      skipped++;
      continue;
    }
    await db.insert(alertRecipients).values({ name: s.name, email, storeId: s.id });
    added++;
  }
  const meta = await requestMeta();
  await audit({ actor, action: "alert.recipient_created", entityType: "system", entityLabel: "store mailboxes", details: { added, skipped }, ...meta });
  revalidate();
  if (added === 0) return failure("Nothing added: those store mailboxes are already recipients or invalid.");
  return success(`${added} store mailbox${added === 1 ? "" : "es"} added${skipped ? ` · ${skipped} skipped` : ""}`);
}

const settingsSchema = z.object({
  alertsEnabled: checkbox,
  dailyReportEnabled: checkbox,
  offlineGraceMinutes: z.coerce.number({ message: "Enter a number of minutes" }).int("Whole minutes only").min(0, "0 or more").max(1440, "At most 1440 (24 h)"),
  dailyReportHour: z.coerce.number().int().min(0).max(23),
});

export async function saveAlertSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser(rolesFor("alerts.manage"));
  const parsed = parseForm(settingsSchema, formData);
  if (!parsed.success) return parsed.state;
  const saved = await saveAlertSettings(parsed.data);
  const meta = await requestMeta();
  await audit({ actor, action: "alert.settings_updated", entityType: "system", entityLabel: "alert settings", details: { ...saved }, ...meta });
  revalidate();
  return success("Alert settings saved", { ...saved });
}

const testSchema = z.object({ to: z.string().trim().toLowerCase().email("Enter a valid email address").max(200) });

export async function sendTestEmailAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser(rolesFor("alerts.manage"));
  const parsed = parseForm(testSchema, formData);
  if (!parsed.success) return parsed.state;
  let result: { ok: boolean; error?: string };
  try {
    result = await sendTestEmail(parsed.data.to);
  } catch (e) {
    result = { ok: false, error: e instanceof Error ? e.message : "Could not send the test email" };
  }
  const meta = await requestMeta();
  await audit({ actor, action: "alert.test_sent", entityType: "system", entityLabel: parsed.data.to, details: { ok: result.ok, smtpConfigured: getMailerStatus().configured }, ...meta });
  revalidate();
  if (!result.ok) return failure(result.error ?? "The test email could not be delivered. See the outbox for details.");
  return success(`Test email sent to ${parsed.data.to}`);
}

export async function sendDailyReportNowAction(day?: string): Promise<ActionState> {
  const actor = await requireUser(rolesFor("alerts.manage"));
  let date: Date | undefined;
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return failure("Choose a valid day.");
    // Midday UTC lands on the same calendar day in Asia/Kolkata and every zone within ±11 h.
    date = new Date(`${day}T06:30:00Z`);
  }
  let recipients = 0;
  let delivery = { sent: 0, failed: 0, skipped: 0 };
  try {
    ({ recipients } = await sendDailyReportNow(date ? { date } : undefined));
    delivery = await flushOutbox();
  } catch (e) {
    return failure(e instanceof Error ? e.message : "Could not build the daily report.");
  }
  const meta = await requestMeta();
  await audit({ actor, action: "alert.daily_report_sent", entityType: "system", entityLabel: day ?? "default day", details: { recipients, ...delivery }, ...meta });
  revalidate();
  if (recipients === 0) return failure("No active recipients have the daily report turned on.");
  if (!getMailerStatus().configured) return success(`Report queued for ${recipients} recipient${recipients === 1 ? "" : "s"}`, { note: "SMTP is not configured, so it was stored in the outbox only." });
  return success(`Report queued for ${recipients} recipient${recipients === 1 ? "" : "s"}`, { ...delivery });
}

export async function flushOutboxAction(): Promise<ActionState> {
  const actor = await requireUser(rolesFor("alerts.manage"));
  let r: { sent: number; failed: number; skipped: number };
  try {
    r = await flushOutbox(200);
  } catch (e) {
    return failure(e instanceof Error ? e.message : "Could not process the outbox.");
  }
  const meta = await requestMeta();
  await audit({ actor, action: "alert.outbox_flushed", entityType: "system", entityLabel: "email outbox", details: { ...r }, ...meta });
  revalidate();
  if (r.sent + r.failed + r.skipped === 0) return success("Outbox is empty: nothing waiting to send");
  return success(`Outbox processed: ${r.sent} sent · ${r.failed} failed · ${r.skipped} skipped`);
}

/** Loads one outbox message body for preview. */
export async function getOutboxMessageAction(id: number): Promise<ActionState> {
  await requireUser(rolesFor("alerts.manage"));
  if (!Number.isInteger(id) || id <= 0) return failure("Message not found.");
  const m = await getOutboxMessage(id);
  if (!m) return failure("Message not found.");
  return success("Loaded", { subject: m.subject, to: m.toAddress, html: m.bodyHtml, text: m.bodyText, kind: m.kind });
}
