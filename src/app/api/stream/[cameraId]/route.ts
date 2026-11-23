import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { apiError, noStore } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { rolesFor } from "@/lib/auth/rbac";
import { requireApiUser, requestMeta } from "@/lib/auth/session";
import { signStreamToken } from "@/lib/auth/stream-token";
import { getCameraForUser } from "@/server/queries/cameras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues a short-lived bearer token for one camera and the public URLs the
 * browser should use to play it (WebRTC/WHEP first, HLS as fallback).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ cameraId: string }> }) {
  try {
    const user = await requireApiUser(rolesFor("live.view"));
    const { cameraId } = await ctx.params;
    // Enforces store AND camera-level assignment; unassigned cameras look like missing ones.
    const camera = await getCameraForUser(user, cameraId);
    if (!camera) return NextResponse.json({ error: "Camera not found" }, { status: 404 });
    if (!camera.isEnabled) return NextResponse.json({ error: "Camera is disabled" }, { status: 409 });

    const { token, expiresAt } = await signStreamToken({
      userId: user.id,
      email: user.email,
      paths: [camera.pathName],
      actions: ["read"],
      tokenVersion: user.tokenVersion,
    });

    const webrtcBase = env.MEDIAMTX_PUBLIC_WEBRTC_URL.replace(/\/$/, "");
    const hlsBase = env.MEDIAMTX_PUBLIC_HLS_URL.replace(/\/$/, "");
    const meta = await requestMeta();
    await audit({ actor: user, action: "stream.viewed", entityType: "camera", entityId: camera.id, entityLabel: camera.name, details: { store: camera.store.code }, ...meta });

    return noStore(
      NextResponse.json({
        camera: { id: camera.id, name: camera.name, status: camera.status, store: camera.store.name, pathName: camera.pathName },
        token,
        expiresAt: expiresAt.toISOString(),
        whepUrl: `${webrtcBase}/${encodeURIComponent(camera.pathName)}/whep`,
        hlsUrl: `${hlsBase}/${encodeURIComponent(camera.pathName)}/index.m3u8`,
      }),
    );
  } catch (e) {
    return apiError(e);
  }
}
