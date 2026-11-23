import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { cameras, playbackSessions, users } from "@/db/schema";
import { env } from "@/env";
import { verifyPassword } from "@/lib/auth/password";
import { isLocked, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";
import { canAccessCamera } from "@/lib/auth/rbac";
import { loadSessionUser, type SessionUser } from "@/lib/auth/session";
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

interface PathOwner {
  cameraId: string;
  storeId: string;
  /** True for playback-session paths. */
  isSession: boolean;
  /** For playback-session paths: the user who opened the session (null once that user is deleted). */
  sessionUserId: string | null;
}

/** Camera behind a stream path: a live camera path, or the camera behind an open playback session. */
async function ownerOfPath(path: string): Promise<PathOwner | null> {
  if (path.startsWith(PLAYBACK_PATH_PREFIX)) {
    const s = await db.query.playbackSessions.findFirst({ where: eq(playbackSessions.pathName, path), with: { camera: { columns: { id: true, storeId: true } } } });
    return s && !s.closedAt ? { cameraId: s.camera.id, storeId: s.camera.storeId, isSession: true, sessionUserId: s.userId ?? null } : null;
  }
  const camera = await db.query.cameras.findFirst({ where: eq(cameras.pathName, path), columns: { id: true, storeId: true, isEnabled: true } });
  return camera && camera.isEnabled ? { cameraId: camera.id, storeId: camera.storeId, isSession: false, sessionUserId: null } : null;
}

/**
 * Store AND camera-level assignment (vms.user_cameras) must allow the camera;
 * a playback session may only be read by the user who opened it (or an admin;
 * an ownerless session is admin-only).
 * MediaMTX "playback" (its recordings server, /get returns whole files) is a
 * download, so it additionally needs the user's effective download right.
 */
function mayRead(user: SessionUser | null, owner: PathOwner | null, action: string): boolean {
  if (!user || !owner) return false;
  if (!canAccessCamera(user, { id: owner.cameraId, storeId: owner.storeId })) return false;
  if (owner.isSession && owner.sessionUserId !== user.id && !user.isAdmin) return false;
  if (action === "playback" && !user.canDownload) return false;
  return true;
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
    ok = mayRead(user, user ? await ownerOfPath(path) : null, action);
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
 * "Permitted" = the user's stores plus any camera-level assignment (see mayRead).
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
    // Same answer for "no such camera" and "no access" so paths cannot be enumerated.
    if (!mayRead(session, session ? await ownerOfPath(path) : null, action)) return deny("Invalid credentials");
    return allow();
  }

  return deny("Authentication required");
}
