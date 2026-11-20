import "server-only";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";

export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.password_changed",
  "user.created",
  "user.updated",
  "user.deleted",
  "user.password_reset",
  "store.created",
  "store.updated",
  "store.deleted",
  "camera.created",
  "camera.updated",
  "camera.deleted",
  "camera.imported",
  "camera.restarted",
  "device.created",
  "device.updated",
  "device.deleted",
  "device.tested",
  "health.check_run",
  "playback.viewed",
  "playback.exported",
  "stream.viewed",
  "settings.updated",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditInput {
  actor?: { id: string; email: string } | null;
  actorEmail?: string | null;
  action: AuditAction;
  entityType?: "user" | "store" | "camera" | "device" | "system" | "recording";
  entityId?: string | null;
  entityLabel?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Records a security/operational event. Never throws: audit failures must not break the main flow. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      actorId: input.actor?.id ?? null,
      actorEmail: input.actor?.email ?? input.actorEmail ?? null,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      entityLabel: input.entityLabel ?? null,
      details: input.details ? JSON.stringify(scrub(input.details)) : null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
    });
  } catch (err) {
    console.error("[audit] failed to write entry", err);
  }
}

const SECRET_KEYS = /pass|secret|token|hash|key/i;
function scrub(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
  }
  return out;
}
