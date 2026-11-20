import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { rolesFor } from "@/lib/auth/rbac";
import { requireApiUser, requestMeta } from "@/lib/auth/session";
import { deviceClock, downloadRecording, searchRecordings } from "@/lib/hikvision/isapi";
import { playbackContext } from "@/lib/playback/sessions";
import { getCameraForUser, getCameraInternal } from "@/server/queries/cameras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams one recorded file straight from the recorder to the browser
 * (?start=&end= of a file returned by /segments). Nothing is written to disk.
 * Hikvision files are the recorder's native container; VLC plays them directly.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ cameraId: string }> }) {
  try {
    const user = await requireApiUser(rolesFor("playback.export"));
    const { cameraId } = await ctx.params;
    const visible = await getCameraForUser(user, cameraId);
    const camera = visible ? await getCameraInternal(cameraId) : null;
    if (!visible || !camera) return NextResponse.json({ error: "Camera not found" }, { status: 404 });

    const sp = req.nextUrl.searchParams;
    const start = new Date(sp.get("start") ?? "");
    const end = new Date(sp.get("end") ?? "");
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      return NextResponse.json({ error: "Invalid start/end" }, { status: 400 });
    }

    const pc = await playbackContext(camera);
    const clock = deviceClock(pc.device, pc.siteTimeZone);
    // Search a slightly wider window and pick the file that overlaps the request the most.
    const files = await searchRecordings(pc.device, pc.trackId, new Date(start.getTime() - 1000), new Date(end.getTime() + 1000), clock);
    const overlap = (f: { start: Date; end: Date }) => Math.max(0, Math.min(f.end.getTime(), end.getTime()) - Math.max(f.start.getTime(), start.getTime()));
    const best = files.filter((f) => f.playbackUri).sort((a, b) => overlap(b) - overlap(a))[0];
    if (!best?.playbackUri || overlap(best) === 0) {
      return NextResponse.json({ error: "No recording file found for that time on the recorder" }, { status: 404 });
    }

    const upstream = await downloadRecording(pc.device, best.playbackUri);
    const meta = await requestMeta();
    await audit({
      actor: user,
      action: "playback.exported",
      entityType: "camera",
      entityId: camera.id,
      entityLabel: camera.name,
      details: { source: "nvr", start: start.toISOString(), end: end.toISOString() },
      ...meta,
    });

    const stamp = start.toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${camera.pathName}_${stamp}.mp4"`,
      "cache-control": "private, no-store",
    });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (e) {
    return apiError(e);
  }
}
