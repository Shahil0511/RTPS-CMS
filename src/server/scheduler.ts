import "server-only";
import { env } from "@/env";
import { runHealthCheck } from "@/lib/health/monitor";
import { registerHikvisionProvider } from "@/lib/hikvision/provider";
import { reconcileAll } from "@/lib/mediamtx/sync";
import { cleanupPlaybackSessions } from "@/lib/playback/sessions";

declare global {
  // eslint-disable-next-line no-var
  var __vmsScheduler: { started: boolean; timers: ReturnType<typeof setInterval>[] } | undefined;
}

const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Background jobs that run inside the Next.js server process:
 *  - reconcile camera paths with MediaMTX (at boot, then every minute; also
 *    heals MediaMTX restarts because API-added paths are not persisted)
 *  - health check (every HEALTH_CHECK_INTERVAL_SECONDS)
 */
export function startScheduler(): void {
  if (globalThis.__vmsScheduler?.started) return;
  const state = { started: true, timers: [] as ReturnType<typeof setInterval>[] };
  globalThis.__vmsScheduler = state;

  const log = (msg: string, ...rest: unknown[]) => console.log(`[scheduler] ${msg}`, ...rest);

  // Read model/serial/disk status from Hikvision recorders during health checks.
  registerHikvisionProvider();

  let reconciling = false;
  const reconcile = async () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const r = await reconcileAll();
      if (r.added.length || r.updated.length || r.removed.length || r.errors.length) {
        log(`reconcile: +${r.added.length} ~${r.updated.length} -${r.removed.length} errors=${r.errors.length}`);
        for (const e of r.errors) log(`  ! ${e.path}: ${e.error}`);
      }
    } catch (e) {
      log(`reconcile skipped: ${(e as Error).message}`);
    } finally {
      reconciling = false;
    }
  };

  const health = async () => {
    try {
      const r = await runHealthCheck();
      for (const t of r.deviceTransitions) log(`recorder ${t.name}: ${t.from} -> ${t.to}`);
      for (const t of r.transitions) log(`${t.name}: ${t.from} -> ${t.to}`);
    } catch (e) {
      log(`health check failed: ${(e as Error).message}`);
    }
  };

  // Give MediaMTX a moment to come up when both start together.
  setTimeout(async () => {
    await reconcile();
    await health();
  }, 3000).unref?.();

  const janitor = async () => {
    try {
      const closed = await cleanupPlaybackSessions();
      if (closed > 0) log(`closed ${closed} idle playback session(s)`);
    } catch (e) {
      log(`playback cleanup skipped: ${(e as Error).message}`);
    }
  };

  const t1 = setInterval(reconcile, RECONCILE_INTERVAL_MS);
  const t3 = setInterval(janitor, 30_000);
  t3.unref?.();
  const t2 = setInterval(health, env.HEALTH_CHECK_INTERVAL_SECONDS * 1000);
  t1.unref?.();
  t2.unref?.();
  state.timers.push(t1, t2, t3);
  log(`started (health every ${env.HEALTH_CHECK_INTERVAL_SECONDS}s, reconcile every ${RECONCILE_INTERVAL_MS / 1000}s)`);
}
