/**
 * Next.js instrumentation hook: runs once when the server boots.
 * Starts the background scheduler (MediaMTX reconciliation + health monitor).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { runMigrations } = await import("./db");
    const { startScheduler } = await import("./server/scheduler");
    await runMigrations();
    startScheduler();
  }
}
