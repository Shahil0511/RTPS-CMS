import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Cross-process mutex for the downtime log + alert dispatch (the web server and
 * `npm run health:run` may both run a check). A transaction-scoped PostgreSQL
 * advisory lock is taken on one pooled connection and held while `fn` runs; it is
 * released automatically on commit/rollback, also when the process dies.
 * Returns { ran: false } without waiting when another process holds the lock.
 *
 * The key is derived from a VMS-specific name so it cannot meet another
 * application's advisory locks on the shared server; no table is touched.
 */
const LOCK_NAME = "libas-vms:alerts";

export async function withAlertLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  return db.transaction(async (tx) => {
    const res = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_NAME})) as ok`);
    if (!res.rows[0]?.ok) return { ran: false } as const;
    return { ran: true, value: await fn() } as const;
  });
}
