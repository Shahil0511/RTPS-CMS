/**
 * In-memory sliding lockout for login attempts. Keyed by IP and by account so
 * neither a single attacker nor a single targeted account can be brute-forced.
 * For multi-instance deployments swap this for a shared store (e.g. Redis).
 */
interface Bucket {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __vmsRateLimit: Map<string, Bucket> | undefined;
}
const buckets = globalThis.__vmsRateLimit ?? (globalThis.__vmsRateLimit = new Map());

function bucket(key: string): Bucket {
  let b = buckets.get(key);
  const now = Date.now();
  if (!b || (b.lockedUntil < now && now - b.firstFailureAt > WINDOW_MS)) {
    b = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
    buckets.set(key, b);
  }
  return b;
}

export function isLocked(key: string): { locked: boolean; retryAfterSeconds: number } {
  const b = buckets.get(key);
  const now = Date.now();
  if (b && b.lockedUntil > now) {
    return { locked: true, retryAfterSeconds: Math.ceil((b.lockedUntil - now) / 1000) };
  }
  return { locked: false, retryAfterSeconds: 0 };
}

export function recordFailure(key: string): void {
  const b = bucket(key);
  b.failures += 1;
  if (b.failures >= MAX_FAILURES) {
    b.lockedUntil = Date.now() + LOCK_MS;
    b.failures = 0;
    b.firstFailureAt = Date.now();
  }
}

export function recordSuccess(key: string): void {
  buckets.delete(key);
}

// Periodic cleanup so the map does not grow unbounded.
if (!globalThis.__vmsRateLimitTimer) {
  globalThis.__vmsRateLimitTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.lockedUntil < now && now - b.firstFailureAt > WINDOW_MS) buckets.delete(k);
    }
  }, 60_000);
  globalThis.__vmsRateLimitTimer.unref?.();
}

declare global {
  // eslint-disable-next-line no-var
  var __vmsRateLimitTimer: ReturnType<typeof setInterval> | undefined;
}
