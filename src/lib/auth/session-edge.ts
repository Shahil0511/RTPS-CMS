import { jwtVerify } from "jose";
import type { Role } from "@/db/schema";

/**
 * Dependency-free session verification used by the request proxy.
 * Reads the secret directly from process.env so it never pulls in the database.
 */
export const SESSION_COOKIE = "vms_session";
const ISSUER = "libas-vms";
const AUDIENCE = "session";

export interface SessionClaims {
  sub: string;
  email: string;
  role: Role;
  tv: number;
  /** User must change password before using the app. */
  pw: boolean;
}

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET is not configured");
  return new TextEncoder().encode(s);
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: AUDIENCE });
    if (!payload.sub || typeof payload.email !== "string" || typeof payload.role !== "string") return null;
    return { sub: payload.sub, email: payload.email, role: payload.role as Role, tv: Number(payload.tv ?? 0), pw: payload.pw === true };
  } catch {
    return null;
  }
}
