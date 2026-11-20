import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { cameras, playbackSessions, users } from "@/db/schema";
import { env } from "@/env";
import { verifyPassword } from "@/lib/auth/password";
import { isLocked, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";
import { canAccessStore } from "@/lib/auth/rbac";
import { loadSessionUser } from "@/lib/auth/session";
import { verifyStreamToken } from "@/lib/auth/stream-token";
import { PLAYBACK_PATH_PREFIX } from "@/lib/mediamtx/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface MtxAuthRequest {
  user?: string;
  password?: string;
  token?: string;
  ip?: string;
  action?: "publish" | "read" | "playback" | "api" | "metrics" | "pprof";
  path?: string;
  protocol?: string;
  id?: string;
  query?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const deny = (reason: string) => NextResponse.json({ error: reason }, { status: 401 });
const allow = () => new NextResponse(null, { status: 200 });

/** Store that owns a stream path: a live camera path, or the camera behind a playback session. */
async function storeOfPath(path: string): Promise<string | null> {
  if (path.startsWith(PLAYBACK_PATH_PREFIX)) {
    const s = await db.query.playbackSessions.findFirst({ where: eq(playbackSessions.pathName, path), with: { camera: { columns: { storeId: true } } } });
    return s && !s.closedAt ? s.camera.storeId : null;
  }
  const camera = await db.query.cameras.findFirst({ where: eq(cameras.pathName, path), columns: { storeId: true, isEnabled: true } });
  return camera && camera.isEnabled ? camera.storeId : null;
}

/**
 * Token decisions are cached briefly: HLS players hit this hook for every
 * playlist/segment request. 30 s bounds how long a revoked user keeps access.
 */
const TOKEN_CACHE_MS = 30_000;
declare global {
  // eslint-disable-next-line no-var
  var __vmsMtxTokenCache: Map<string, { ok: boolean; until: number }> | undefined;
}
const tokenCache = globalThis.__vmsMtxTokenCache ?? (globalThis.__vmsMtxTokenCache = new Map());

async function tokenAllows(token: string, action: string, path: string): Promise<boolean> {
  const key = `${token}|${action}|${path}`;
  const hit = tokenCache.get(key);
  if (hit && hit.until > Date.now()) return hit.ok;

  let ok = false;
  const claims = await verifyStreamToken(token);
  if (claims && claims.actions.includes(action as "read" | "playback") && (claims.paths.includes("*") || claims.paths.includes(path))) {
    // Re-check the account on every (uncached) decision: deactivation, password
    // reset or losing the site revokes stream access within TOKEN_CACHE_MS.
    const user = await loadSessionUser(claims.userId, claims.tokenVersion);
    const storeId = user ? await storeOfPath(path) : null;
    ok = Boolean(user && storeId && canAccessStore(user, storeId));
  }
  if (tokenCache.size > 5000) tokenCache.clear();
  tokenCache.set(key, { ok, until: Date.now() + TOKEN_CACHE_MS });
  return ok;
}

/**
 * Called by MediaMTX for every action (see mediamtx.yml -> authHTTPAddress).
 * Only MediaMTX knows the secret in its auth URL (?k=...), so the endpoint
 * cannot be used from outside as a password-guessing oracle. Accepted credentials:
 *  1. the VMS service account (Basic auth from this server)        -> any action
 *  2. a stream bearer token issued by the app                       -> read of that path
 *  3. a VMS username/password (e.g. VLC via rtsp://user:pass@host)  -> read of permitted cameras
 * Password checks (1 and 3) share the login lockout.
 */
export async function POST(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("k") ?? "";
  if (!safeEqual(key, env.MEDIAMTX_AUTH_SECRET)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: MtxAuthRequest;
  try {
    body = (await req.json()) as MtxAuthRequest;
  } catch {
    return deny("Malformed request");
  }
  const action = body.action ?? "read";
  const path = body.path ?? "";
  const ipKey = `ip:${body.ip ?? "unknown"}`;

  // 1. Service account (rate limited by client IP)
  if (body.user && body.password && safeEqual(body.user, env.MEDIAMTX_API_USER)) {
    if (isLocked(ipKey).locked) return deny("Too many failed attempts");
    if (safeEqual(body.password, env.MEDIAMTX_API_PASS)) return allow();
    recordFailure(ipKey);
    return deny("Invalid credentials");
  }

  // Nobody else may publish or use the API.
  if (action !== "read" && action !== "playback") return deny("Action not permitted");
  if (!path) return deny("Path required");

  // 2. Bearer token from the browser player
  if (body.token) {
    return (await tokenAllows(body.token, action, path)) ? allow() : deny("Stream token not valid for this stream");
  }

  // 3. VMS user credentials (external RTSP clients), with the same lockout as the login page
  if (body.user && body.password) {
    const email = body.user.toLowerCase();
    const acctKey = `acct:${email}`;
    if (isLocked(ipKey).locked || isLocked(acctKey).locked) return deny("Too many failed attempts");
    const account = await db.query.users.findFirst({ where: eq(users.email, email) });
    const valid = account && account.isActive && !account.mustChangePassword ? await verifyPassword(body.password, account.passwordHash) : false;
    if (!account || !valid) {
      recordFailure(ipKey);
      recordFailure(acctKey);
      return deny("Invalid credentials");
    }
    recordSuccess(acctKey);
    const session = await loadSessionUser(account.id);
    const storeId = session ? await storeOfPath(path) : null;
    // Same answer for "no such camera" and "no access" so paths cannot be enumerated.
    if (!session || !storeId || !canAccessStore(session, storeId)) return deny("Invalid credentials");
    return allow();
  }

  return deny("Authentication required");
}
