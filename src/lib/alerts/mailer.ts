import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { and, asc, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { db, type Db } from "@/db";
import { emailOutbox, type EmailKind, type NewEmailOutbox } from "@/db/schema";
import { env } from "@/env";
import { renderTestEmail } from "./templates";

/**
 * Outgoing email. Every message is written to vms.email_outbox first so delivery is
 * visible in the UI; without SMTP configured, messages are stored as SKIPPED_NO_SMTP.
 * Delivery uses nodemailer with the SMTP_* settings. Credentials are never logged,
 * stored in the outbox or returned to callers.
 */

export interface OutgoingEmail {
  kind: EmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Delivery attempts per message before it is marked FAILED. */
export const MAX_SEND_ATTEMPTS = 3;
/** Minimum age of a message (since it was queued) before attempt n+1, so retries back off. */
const RETRY_AFTER_MS = [0, 60_000, 5 * 60_000] as const;
const SEND_TIMEOUT_MS = 20_000;

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

declare global {
  // eslint-disable-next-line no-var
  var __vmsMailer: { transport: Transporter | null; key: string | null; flushing: boolean } | undefined;
}
const state = globalThis.__vmsMailer ?? (globalThis.__vmsMailer = { transport: null, key: null, flushing: false });

/** SMTP readiness for the UI. Never exposes credentials. */
export function getMailerStatus(): { configured: boolean; host: string | null; from: string | null } {
  const host = env.SMTP_HOST ?? null;
  const from = env.SMTP_FROM ?? env.SMTP_USER ?? null;
  return { configured: Boolean(host && from), host, from };
}

/** Lazily created transport; rebuilt only when the SMTP settings change (hot reload). */
function transport(): Transporter {
  const key = [env.SMTP_HOST, env.SMTP_PORT, env.SMTP_SECURE, env.SMTP_USER].join("|");
  if (!state.transport || state.key !== key) {
    state.transport?.close();
    state.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    });
    state.key = key;
  }
  return state.transport;
}

/** Error text that is safe to store and show: no credentials, bounded length. */
function safeError(e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e);
  const secret = env.SMTP_PASS;
  if (secret && secret.length >= 3) msg = msg.split(secret).join("***");
  msg = msg.replace(/(AUTH\s+(?:PLAIN|LOGIN)\s+)\S+/gi, "$1***");
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}

async function deliver(row: { toAddress: string; subject: string; bodyText: string; bodyHtml: string }): Promise<void> {
  const { from } = getMailerStatus();
  await transport().sendMail({
    from: from ?? undefined,
    to: row.toAddress,
    subject: row.subject,
    text: row.bodyText,
    html: row.bodyHtml,
  });
}

function toRow(m: OutgoingEmail, configured: boolean): NewEmailOutbox {
  return {
    kind: m.kind,
    toAddress: m.to.trim(),
    subject: m.subject,
    bodyText: m.text,
    bodyHtml: m.html,
    status: configured ? "QUEUED" : "SKIPPED_NO_SMTP",
    lastError: configured ? null : "SMTP is not configured",
  };
}

/** Stores an email in the outbox and returns its id. */
export async function queueEmail(m: OutgoingEmail): Promise<number> {
  const [id] = await queueEmails([m]);
  if (id === undefined) throw new Error("Failed to queue email");
  return id;
}

/**
 * Stores several emails at once. Pass a transaction as `executor` to queue them atomically
 * with other writes (e.g. marking incidents as alerted).
 */
export async function queueEmails(list: OutgoingEmail[], executor: Executor = db): Promise<number[]> {
  if (list.length === 0) return [];
  const { configured } = getMailerStatus();
  const ids: number[] = [];
  for (let i = 0; i < list.length; i += 100) {
    const rows = await executor
      .insert(emailOutbox)
      .values(list.slice(i, i + 100).map((m) => toRow(m, configured)))
      .returning({ id: emailOutbox.id });
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

/** A SENDING claim older than this was interrupted (process died mid-send). */
const STALE_CLAIM_MS = 15 * 60_000;

/** Status write after a delivery attempt. Retried briefly: a lost write must not turn into a resend. */
async function recordOutcome(id: number, set: Partial<NewEmailOutbox>, context: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.update(emailOutbox).set(set).where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "SENDING")));
      return;
    } catch (e) {
      if (attempt >= 3) {
        // The row stays SENDING; the stale-claim sweep marks it FAILED ("outcome unknown"), never resends it.
        console.error(`[mailer] outbox #${id}: could not record ${context}: ${(e as Error).message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

/**
 * Delivers queued emails, oldest first. Rows are claimed atomically (QUEUED -> SENDING with
 * FOR UPDATE SKIP LOCKED), so two processes never send the same message. A failed message goes
 * back to QUEUED and is retried after a back-off (1 min, then 5 min after it was queued); after
 * MAX_SEND_ATTEMPTS it is marked FAILED. A claim left behind by a crash is marked FAILED
 * ("outcome unknown") rather than retried, because the message may already have gone out.
 * Without SMTP, queued rows are marked SKIPPED_NO_SMTP. Never throws for delivery errors;
 * overlapping calls in one process are skipped.
 */
export async function flushOutbox(limit = 50): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  if (state.flushing) return out;
  state.flushing = true;
  try {
    const now = new Date();
    // TEST emails are sent inline by sendTestEmail and never retried here.
    const pending = and(eq(emailOutbox.status, "QUEUED"), lt(emailOutbox.attempts, MAX_SEND_ATTEMPTS), ne(emailOutbox.kind, "TEST"));

    await db
      .update(emailOutbox)
      .set({ status: "FAILED", lastError: "Delivery was interrupted; outcome unknown, so it is not retried (it may have been delivered)." })
      .where(and(eq(emailOutbox.status, "SENDING"), lt(emailOutbox.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS))));

    if (!getMailerStatus().configured) {
      const rows = await db
        .update(emailOutbox)
        .set({ status: "SKIPPED_NO_SMTP", lastError: "SMTP is not configured" })
        .where(pending)
        .returning({ id: emailOutbox.id });
      out.skipped = rows.length;
      return out;
    }

    // Due = old enough for its next attempt (back-off measured from when it was queued).
    const due = or(
      and(eq(emailOutbox.attempts, 0), lte(emailOutbox.createdAt, now)),
      and(eq(emailOutbox.attempts, 1), lte(emailOutbox.createdAt, new Date(now.getTime() - RETRY_AFTER_MS[1]))),
      and(gte(emailOutbox.attempts, 2), lte(emailOutbox.createdAt, new Date(now.getTime() - RETRY_AFTER_MS[2]))),
    );
    const claimable = db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)
      .where(and(pending, due))
      .orderBy(asc(emailOutbox.createdAt), asc(emailOutbox.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed = await db
      .update(emailOutbox)
      .set({ status: "SENDING", claimedAt: now, attempts: sql`${emailOutbox.attempts} + 1` })
      .where(and(inArray(emailOutbox.id, claimable), eq(emailOutbox.status, "QUEUED")))
      .returning();
    claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);

    for (const row of claimed) {
      const attempts = row.attempts; // already counts this attempt
      let error: string | null = null;
      try {
        await deliver(row);
      } catch (e) {
        error = safeError(e);
      }
      if (error === null) {
        await recordOutcome(row.id, { status: "SENT", sentAt: new Date(), lastError: null }, "a successful delivery");
        out.sent += 1;
      } else {
        const final = attempts >= MAX_SEND_ATTEMPTS;
        await recordOutcome(row.id, { status: final ? "FAILED" : "QUEUED", lastError: error }, "a failed delivery");
        out.failed += 1;
        console.warn(`[mailer] outbox #${row.id} (${row.kind}) attempt ${attempts}/${MAX_SEND_ATTEMPTS} failed: ${error}`);
      }
    }
    return out;
  } finally {
    state.flushing = false;
  }
}

/**
 * Sends a TEST email immediately (no retries) and records the outcome in the outbox. The row is
 * written after delivery with its final status, so a test can never be left QUEUED.
 */
export async function sendTestEmail(to: string): Promise<{ ok: boolean; error?: string }> {
  const m = renderTestEmail();
  const base = { kind: "TEST" as const, toAddress: to.trim(), subject: m.subject, bodyText: m.text, bodyHtml: m.html };
  if (!getMailerStatus().configured) {
    await db.insert(emailOutbox).values({ ...base, status: "SKIPPED_NO_SMTP", lastError: "SMTP is not configured" });
    return { ok: false, error: "SMTP is not configured. The message was stored in the outbox only." };
  }

  let error: string | null = null;
  try {
    await deliver(base);
  } catch (e) {
    error = safeError(e);
  }
  try {
    await db
      .insert(emailOutbox)
      .values(error === null ? { ...base, status: "SENT", attempts: 1, sentAt: new Date() } : { ...base, status: "FAILED", attempts: 1, lastError: error });
  } catch (e) {
    console.error(`[mailer] test email ${error === null ? "sent" : "failed"} but could not be recorded: ${(e as Error).message}`);
  }
  return error === null ? { ok: true } : { ok: false, error };
}
