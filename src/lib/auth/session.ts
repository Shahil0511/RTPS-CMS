import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cameras, userCameras, users, userStores, type Role, type User } from "@/db/schema";
import { env, isProd } from "@/env";
import { can } from "./rbac";
import { SESSION_COOKIE, verifySessionToken } from "./session-edge";

export { SESSION_COOKIE, verifySessionToken };
const secret = new TextEncoder().encode(env.SESSION_SECRET);
const ISSUER = "libas-vms";
const AUDIENCE = "session";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  /** Incremented on password reset / role change; embedded in stream tokens. */
  tokenVersion: number;
  /** Store ids this user may access. Empty array for ADMIN means "all". */
  storeIds: string[];
  isAdmin: boolean;
  /**
   * Camera-level restrictions: storeId -> camera ids the user may see in that
   * store. Every store whose user_stores.camera_limited flag is set appears here
   * (with its user_cameras grants, possibly an empty list = no cameras); a store
   * in storeIds but absent from this record means "every camera of that store".
   * Always empty for ADMIN.
   */
  cameraScope: Record<string, string[]>;
  /** Per-user download override (null = role default). */
  allowDownload: boolean | null;
  /** Effective footage-download right: allowDownload ?? role permission "playback.export". */
  canDownload: boolean;
}

export async function signSessionToken(user: Pick<User, "id" | "email" | "role" | "tokenVersion" | "mustChangePassword">): Promise<string> {
  const ttlSeconds = env.SESSION_TTL_HOURS * 3600;
  return new SignJWT({ email: user.email, role: user.role, tv: user.tokenVersion, pw: user.mustChangePassword })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd && env.APP_URL.startsWith("https://"),
    path: "/",
    maxAge: env.SESSION_TTL_HOURS * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/** Loads the fully-hydrated user for the current request (cached per request). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const claims = await verifySessionToken(token);
  if (!claims) return null;
  return loadSessionUser(claims.sub, claims.tv);
});

export async function loadSessionUser(userId: string, tokenVersion?: number): Promise<SessionUser | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.isActive) return null;
  if (tokenVersion !== undefined && user.tokenVersion !== tokenVersion) return null;
  const isAdmin = user.role === "ADMIN";
  const [assignments, grants] = isAdmin
    ? [[], []]
    : await Promise.all([
        db.select({ storeId: userStores.storeId, cameraLimited: userStores.cameraLimited }).from(userStores).where(eq(userStores.userId, user.id)),
        db
          .select({ cameraId: userCameras.cameraId, storeId: cameras.storeId })
          .from(userCameras)
          .innerJoin(cameras, eq(cameras.id, userCameras.cameraId))
          .where(eq(userCameras.userId, user.id)),
      ]);
  const storeIds = assignments.map((a) => a.storeId);
  const cameraScope: Record<string, string[]> = {};
  for (const a of assignments) if (a.cameraLimited) cameraScope[a.storeId] = [];
  for (const g of grants) {
    // Grants only narrow a camera-limited store; elsewhere (including stores the
    // user is not assigned to) they are ignored and never widen access.
    cameraScope[g.storeId]?.push(g.cameraId);
  }
  const allowDownload = isAdmin ? null : (user.allowDownload ?? null);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    tokenVersion: user.tokenVersion,
    storeIds,
    isAdmin,
    cameraScope,
    allowDownload,
    canDownload: allowDownload ?? can({ role: user.role }, "playback.export"),
  };
}

/** Server-component / action guard. Redirects to the login page when not authenticated. */
export async function requireUser(allowed?: Role[]): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (allowed && !allowed.includes(user.role)) redirect("/?denied=1");
  return user;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status: 401 | 403 = 401,
  ) {
    super(message);
  }
}

/** Route-handler / action guard that throws instead of redirecting. */
export async function requireApiUser(allowed?: Role[]): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("Not authenticated", 401);
  if (allowed && !allowed.includes(user.role)) throw new AuthError("Forbidden", 403);
  return user;
}

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  const ip = fwd ? (fwd.split(",")[0]?.trim() ?? null) : (h.get("x-real-ip") ?? null);
  return { ip, userAgent: h.get("user-agent") };
}
