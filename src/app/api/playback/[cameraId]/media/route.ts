import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/rbac";
import { requireApiUser, requestMeta } from "@/lib/auth/session";
import { mediaMtxAuthHeaders, mtx } from "@/lib/mediamtx/client";
import { getCameraForUser } from "@/server/queries/cameras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CLIP_SECONDS = 6 * 3600;

/**
 * Streams a recording from the MediaMTX playback server to the browser.
 * ?start=ISO&duration=seconds[&format=mp4|fmp4][&download=1]
 * Range requests are forwarded so <video> seeking works.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ cameraId: string }> }) {
  try {
    const user = await requireApiUser();
    const { cameraId } = await ctx.params;
    const camera = await getCameraForUser(user, cameraId);
    if (!camera) return NextResponse.json({ error: "Camera not found" }, { status: 404 });

    const sp = req.nextUrl.searchParams;
    const start = new Date(sp.get("start") ?? "");
    const duration = Number(sp.get("duration") ?? "0");
    const format = sp.get("format") === "mp4" ? "mp4" : "fmp4";
    const download = sp.get("download") === "1";
    if (Number.isNaN(start.getTime()) || !Number.isFinite(duration) || duration <= 0 || duration > MAX_CLIP_SECONDS) {
      return NextResponse.json({ error: "Invalid start/duration" }, { status: 400 });
    }
    if (download && !can(user, "playback.export")) {
      return NextResponse.json({ error: "Export not permitted for your role" }, { status: 403 });
    }

    const upstreamUrl = mtx.playbackGetUrl(camera.pathName, start, duration, format);
    const range = req.headers.get("range");
    const upstream = await fetch(upstreamUrl, {
      headers: { ...mediaMtxAuthHeaders(), ...(range ? { Range: range } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      const text = await upstream.text().catch(() => "");
      const status = upstream.status === 404 ? 404 : 502;
      return NextResponse.json({ error: upstream.status === 404 ? "No recording for that time" : "Playback server error", detail: text.slice(0, 300) }, { status });
    }

    // Log a view once per clip (first byte request), not for every seek.
    if (!range || range.startsWith("bytes=0-")) {
      const meta = await requestMeta();
      await audit({
        actor: user,
        action: download ? "playback.exported" : "playback.viewed",
        entityType: "camera",
        entityId: camera.id,
        entityLabel: camera.name,
        details: { start: start.toISOString(), duration, format },
        ...meta,
      });
    }

    const headers = new Headers();
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has("content-type")) headers.set("content-type", "video/mp4");
    headers.set("cache-control", "private, no-store");
    if (download) {
      const stamp = start.toISOString().replace(/[:.]/g, "-");
      headers.set("content-disposition", `attachment; filename="${camera.pathName}_${stamp}.mp4"`);
    }
    return new NextResponse(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return apiError(e);
  }
}
