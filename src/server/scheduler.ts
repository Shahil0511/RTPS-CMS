import "server-only";
import { env } from "@/env";
import { flushOutbox } from "@/lib/alerts/mailer";
import { runDailyReportIfDue } from "@/lib/alerts/reports";
import { zonedDateKey } from "@/lib/alerts/time";
import { runHealthCheck } from "@/lib/health/monitor";
import { registerHikvisionProvider } from "@/lib/hikvision/provider";
import { reconcileAll } from "@/lib/mediamtx/sync";
import { cleanupPlaybackSessions } from "@/lib/playback/sessions";

declare global {
  // eslint-disable-next-line no-var
  var __vmsScheduler: { started: boolean; timers: ReturnType<typeof setInterval>[] } | undefined;
}

const RECONCILE_INTERVAL_MS = 60_000;
const MAIL_INTERVAL_MS = 60_000;
/** Daily-report attempts per local day after failures, so a persistent error does not retry every minute forever. */
const MAX_DAILY_REPORT_ATTEMPTS = 5;
/** Wait between daily-report attempts after a failure. */
const DAILY_REPORT_RETRY_MS = 15 * 60_000;

/**
 * Background jobs that run inside the Next.js server process:
 *  - reconcile camera paths with MediaMTX (at boot, then every minute; also
 *    heals MediaMTX restarts because API-added paths are not persisted)
 *  - health check (every HEALTH_CHECK_INTERVAL_SECONDS); each run also updates the downtime
 *    log and queues offline/restored alert emails, which are delivered right after the run
 *  - email outbox delivery and retries (every minute)
 *  - daily health report (checked every minute; sent once per local day at the configured hour)
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

  let flushing = false;
  const flushMail = async () => {
    if (flushing) return;
    flushing = true;
    try {
      const r = await flushOutbox();
      if (r.sent || r.failed) log(`mail: sent=${r.sent} failed=${r.failed}`);
    } catch (e) {
      log(`mail delivery skipped: ${(e as Error).message}`);
    } finally {
      flushing = false;
    }
  };

  const health = async () => {
    try {
      const r = await runHealthCheck();
      for (const t of r.deviceTransitions) log(`recorder ${t.name}: ${t.from} -> ${t.to}`);
      for (const t of r.transitions) log(`${t.name}: ${t.from} -> ${t.to}`);
      if (r.incidentsOpened || r.incidentsClosed) log(`downtime: opened=${r.incidentsOpened} closed=${r.incidentsClosed}`);
      if (r.alertEmailsQueued) {
        log(`alerts: ${r.alertEmailsQueued} email(s) queued`);
        await flushMail();
      }
    } catch (e) {
      log(`health check failed: ${(e as Error).message}`);
    }
  };

  // Attempts are counted per local day (ALERT_TIMEZONE, the day the report is about), not per UTC day.
  const reportAttempts = { day: "", count: 0, retryAt: 0 };
  let reporting = false;
  const dailyReport = async () => {
    if (reporting) return;
    const today = zonedDateKey(new Date(), env.ALERT_TIMEZONE);
    if (reportAttempts.day !== today) Object.assign(reportAttempts, { day: today, count: 0, retryAt: 0 });
    if (reportAttempts.count >= MAX_DAILY_REPORT_ATTEMPTS) return;
    if (Date.now() < reportAttempts.retryAt) return;
    reporting = true;
    try {
      const r = await runDailyReportIfDue();
      if (r.sent) {
        log(`daily report for ${r.day}: queued for ${r.recipients} recipient(s)`);
        await flushMail();
      }
    } catch (e) {
      reportAttempts.count += 1;
      reportAttempts.retryAt = Date.now() + DAILY_REPORT_RETRY_MS;
      log(`daily report failed (attempt ${reportAttempts.count}/${MAX_DAILY_REPORT_ATTEMPTS}, next try in ${DAILY_REPORT_RETRY_MS / 60_000} min): ${(e as Error).message}`);
    } finally {
      reporting = false;
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
  // Outbox retries and the daily report share one minute tick.
  const t4 = setInterval(async () => {
    await flushMail();
    await dailyReport();
  }, MAIL_INTERVAL_MS);
  t1.unref?.();
  t2.unref?.();
  t4.unref?.();
  state.timers.push(t1, t2, t3, t4);
  log(`started (health every ${env.HEALTH_CHECK_INTERVAL_SECONDS}s, reconcile every ${RECONCILE_INTERVAL_MS / 1000}s)`);
}
