import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/env";

/**
 * Short-lived bearer tokens handed to the browser so MediaMTX can authorise
 * WebRTC/HLS reads for exactly one camera path. Validated by the
 * /api/internal/mediamtx-auth endpoint that MediaMTX calls.
 */
const secret = new TextEncoder().encode(env.SESSION_SECRET);
const ISSUER = "libas-vms";
const AUDIENCE = "mediamtx";
export const STREAM_TOKEN_TTL_SECONDS = 8 * 3600;

export interface StreamTokenClaims {
  userId: string;
  email: string;
  paths: string[];
  actions: Array<"read" | "playback">;
  /** Account token version at issue time; a password reset or role change revokes the token. */
  tokenVersion: number;
}

export async function signStreamToken(claims: StreamTokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + STREAM_TOKEN_TTL_SECONDS * 1000);
  const token = await new SignJWT({ email: claims.email, paths: claims.paths, actions: claims.actions, tv: claims.tokenVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secret);
  return { token, expiresAt };
}

export async function verifyStreamToken(token: string): Promise<StreamTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
    if (!payload.sub || !Array.isArray(payload.paths)) return null;
    return {
      userId: payload.sub,
      email: String(payload.email ?? ""),
      paths: payload.paths.map(String),
      actions: Array.isArray(payload.actions) ? (payload.actions as StreamTokenClaims["actions"]) : ["read"],
      tokenVersion: Number(payload.tv ?? -1),
    };
  } catch {
    return null;
  }
}
