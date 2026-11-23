import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { cameras, playbackSessions } from "@/db/schema";
import { canAccessCamera } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";
import { mtx } from "./client";

/**
 * Ends stream access a user just lost (fewer locations/cameras, deactivated or deleted).
 *
 * HLS and recording downloads are re-authorised by MediaMTX on every request (see
 * /api/internal/mediamtx-auth, cached for at most 30 s), so they stop on their own.
 * WebRTC/RTSP readers are authorised once at connect time, so the readers of every
 * camera path the user can no longer see are disconnected; MediaMTX cannot tell which
 * reader belongs to whom, so other viewers of those cameras reconnect automatically
 * (the live player retries) and are authorised again. The user's own playback sessions
 * on those cameras are closed.
 *
 * Best effort: a MediaMTX outage never blocks the user change; the stream token
 * (8 h) and the per-request checks still bound access.
 */
export async function revokeLostStreamAccess(before: SessionUser | null, after: SessionUser | null): Promise<{ cameras: number; kicked: number; sessions: number }> {
  const out = { cameras: 0, kicked: 0, sessions: 0 };
  if (!before) return out;
  if (!before.isAdmin && before.storeIds.length === 0) return out;
  const rows = await db
    .select({ id: cameras.id, storeId: cameras.storeId, pathName: cameras.pathName })
    .from(cameras)
    .where(before.isAdmin ? undefined : inArray(cameras.storeId, before.storeIds));
  const lost = rows.filter((c) => canAccessCamera(before, c) && !(after && canAccessCamera(after, c)));
  out.cameras = lost.length;
  if (lost.length === 0) return out;

  // Drop cached "allowed" auth decisions first, or a kicked reader would be let straight back in.
  globalThis.__vmsMtxTokenCache?.clear();
  out.sessions = await closeUserPlaybackSessions(before.id, lost.map((c) => c.id));

  try {
    const lostPaths = new Set(lost.map((c) => c.pathName));
    const paths = await mtx.listPaths();
    for (const p of paths) {
      if (!lostPaths.has(p.name) || (p.readers?.length ?? 0) === 0) continue;
      out.kicked += await mtx.kickReaders(p).catch(() => 0);
    }
  } catch (e) {
    console.warn(`[access] could not disconnect live readers after an access change: ${(e as Error).message}`);
  }
  return out;
}

/**
 * Closes a user's open playback sessions (all of them, or only those on `cameraIds`).
 * Deleting the MediaMTX path disconnects whoever reads it. Call it before deleting a
 * user: their sessions lose their owner (user_id set null) on delete.
 */
export async function closeUserPlaybackSessions(userId: string, cameraIds?: string[]): Promise<number> {
  if (cameraIds && cameraIds.length === 0) return 0;
  const sessions: Array<{ id: string; pathName: string }> = [];
  const open = and(eq(playbackSessions.userId, userId), isNull(playbackSessions.closedAt));
  if (!cameraIds) {
    sessions.push(...(await db.select({ id: playbackSessions.id, pathName: playbackSessions.pathName }).from(playbackSessions).where(open)));
  } else {
    for (let i = 0; i < cameraIds.length; i += 500) {
      sessions.push(
        ...(await db
          .select({ id: playbackSessions.id, pathName: playbackSessions.pathName })
          .from(playbackSessions)
          .where(and(open, inArray(playbackSessions.cameraId, cameraIds.slice(i, i + 500))))),
      );
    }
  }
  for (const s of sessions) {
    await mtx.deletePath(s.pathName).catch(() => undefined);
    await db.update(playbackSessions).set({ closedAt: new Date() }).where(eq(playbackSessions.id, s.id));
  }
  return sessions.length;
}
