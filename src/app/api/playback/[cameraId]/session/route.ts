import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { apiError, noStore } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { rolesFor } from "@/lib/auth/rbac";
import { requireApiUser, requestMeta } from "@/lib/auth/session";
import { signStreamToken } from "@/lib/auth/stream-token";
import { createPlaybackSession } from "@/lib/playback/sessions";
import { getCameraForUser, getCameraInternal } from "@/server/queries/cameras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Opens a playback session that streams the recorder's footage from ?start
 * (ISO) until ?end (ISO, optional). Response shape matches /api/stream/:id so
 * the same WebRTC/HLS player can render it.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ cameraId: string }> }) {
  try {
    const user = await requireApiUser(rolesFor("playback.view"));
    const { cameraId } = await ctx.params;
    const visible = await getCameraForUser(user, cameraId);
    const camera = visible ? await getCameraInternal(cameraId) : null;
    if (!visible || !camera) return NextResponse.json({ error: "Camera not found" }, { status: 404 });

    const sp = req.nextUrl.searchParams;
    const start = new Date(sp.get("start") ?? "");
    const end = sp.get("end") ? new Date(sp.get("end") as string) : null;
    const session = await createPlaybackSession(camera, user.id, start, end);
    const { token, expiresAt } = await signStreamToken({ userId: user.id, email: user.email, paths: [session.pathName], actions: ["read"], tokenVersion: user.tokenVersion });

    const meta = await requestMeta();
    await audit({
      actor: user,
      action: "playback.viewed",
      entityType: "camera",
      entityId: camera.id,
      entityLabel: camera.name,
      details: { source: "nvr", start: session.startAt.toISOString(), end: session.endAt.toISOString(), store: visible.store.code },
      ...meta,
    });

    const webrtcBase = env.MEDIAMTX_PUBLIC_WEBRTC_URL.replace(/\/$/, "");
    const hlsBase = env.MEDIAMTX_PUBLIC_HLS_URL.replace(/\/$/, "");
    return noStore(
      NextResponse.json({
        camera: { id: camera.id, name: camera.name, status: camera.status, store: visible.store.name, pathName: session.pathName },
        sessionId: session.id,
        startAt: session.startAt.toISOString(),
        endAt: session.endAt.toISOString(),
        token,
        expiresAt: expiresAt.toISOString(),
        whepUrl: `${webrtcBase}/${session.pathName}/whep`,
        hlsUrl: `${hlsBase}/${session.pathName}/index.m3u8`,
      }),
    );
  } catch (e) {
    return apiError(e);
  }
}
