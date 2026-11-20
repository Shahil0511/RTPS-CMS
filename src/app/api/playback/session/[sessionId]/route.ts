import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-utils";
import { requireApiUser } from "@/lib/auth/session";
import { closePlaybackSession } from "@/lib/playback/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ends a playback session early (user pressed stop, seeked, or left the page). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireApiUser();
    const { sessionId } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return NextResponse.json({ error: "Invalid session" }, { status: 400 });
    const closed = await closePlaybackSession(sessionId, user.isAdmin ? undefined : user.id);
    return NextResponse.json({ ok: closed });
  } catch (e) {
    return apiError(e);
  }
}

/** sendBeacon() can only POST; treat it as a close. */
export const POST = DELETE;
