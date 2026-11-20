import { NextResponse, type NextRequest } from "next/server";
import { apiError, noStore } from "@/lib/api-utils";
import { requireApiUser } from "@/lib/auth/session";
import { deviceClock, mergeSegments, searchRecordings } from "@/lib/hikvision/isapi";
import { mtx } from "@/lib/mediamtx/client";
import { playbackContext } from "@/lib/playback/sessions";
import { getCameraForUser, getCameraInternal } from "@/server/queries/cameras";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WINDOW_MS = 7 * 86400_000;

/**
 * Lists recordings for a camera between ?from and ?to (ISO timestamps).
 * NVR cameras are searched on the recorder itself (ISAPI); LOCAL cameras use
 * MediaMTX's own recordings.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ cameraId: string }> }) {
  try {
    const user = await requireApiUser();
    const { cameraId } = await ctx.params;
    const visible = await getCameraForUser(user, cameraId);
    if (!visible) return NextResponse.json({ error: "Camera not found" }, { status: 404 });

    const sp = req.nextUrl.searchParams;
    const to = sp.get("to") ? new Date(sp.get("to") as string) : new Date();
    const from = sp.get("from") ? new Date(sp.get("from") as string) : new Date(to.getTime() - 86400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }
    if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
      return NextResponse.json({ error: "Date range too large (max 7 days)" }, { status: 400 });
    }
    const end = to.getTime() > Date.now() ? new Date() : to;

    if (visible.playbackMode === "NVR") {
      const camera = await getCameraInternal(cameraId);
      if (!camera) return NextResponse.json({ error: "Camera not found" }, { status: 404 });
      const pc = await playbackContext(camera);
      const clock = deviceClock(pc.device, pc.siteTimeZone);
      const files = await searchRecordings(pc.device, pc.trackId, from, end, clock);
      const blocks = mergeSegments(files);
      const toItem = (s: { start: Date; end: Date }) => ({ start: s.start.toISOString(), end: s.end.toISOString(), duration: (s.end.getTime() - s.start.getTime()) / 1000 });
      return noStore(
        NextResponse.json({
          source: "nvr",
          camera: { id: visible.id, name: visible.name },
          recorder: { name: pc.device.name, timeMode: clock.mode, utcOffsetMinutes: clock.offsetMinutes },
          items: blocks.map(toItem),
          files: files.map(toItem),
          totalSeconds: blocks.reduce((a, s) => a + (s.end.getTime() - s.start.getTime()) / 1000, 0),
        }),
      );
    }

    if (visible.playbackMode === "LOCAL") {
      const segments = await mtx.playbackList(visible.pathName, from, end);
      const items = segments
        .map((s) => ({ start: s.start, duration: s.duration ?? 0 }))
        .filter((s) => s.duration > 0)
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((s) => ({ ...s, end: new Date(new Date(s.start).getTime() + s.duration * 1000).toISOString() }));
      return noStore(
        NextResponse.json({ source: "local", camera: { id: visible.id, name: visible.name }, items, files: items, totalSeconds: items.reduce((a, s) => a + s.duration, 0) }),
      );
    }

    return noStore(NextResponse.json({ source: "none", camera: { id: visible.id, name: visible.name }, items: [], files: [], totalSeconds: 0 }));
  } catch (e) {
    return apiError(e);
  }
}
