import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth/session";
import { DigestAuthError } from "@/lib/hikvision/digest";
import { IsapiError } from "@/lib/hikvision/isapi";
import { MediaMtxError } from "@/lib/mediamtx/client";
import { PlaybackError } from "@/lib/playback/sessions";

export function apiError(error: unknown): NextResponse {
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof PlaybackError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof DigestAuthError) {
    return NextResponse.json({ error: "Recorder login failed", detail: "Check the recorder's username and password on the Recorders page." }, { status: 502 });
  }
  if (error instanceof IsapiError) {
    return NextResponse.json({ error: "Recorder error", detail: error.message }, { status: 502 });
  }
  if (error instanceof MediaMtxError) {
    return NextResponse.json({ error: "Streaming server error", detail: error.message }, { status: 502 });
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return NextResponse.json({ error: "Recorder did not respond in time" }, { status: 504 });
  }
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    const cause = (error as TypeError & { cause?: { code?: string; address?: string } }).cause;
    const detail = cause?.code ? `${cause.code}${cause.address ? ` ${cause.address}` : ""}` : "Service not reachable from the application server.";
    return NextResponse.json({ error: "Service unreachable", detail }, { status: 502 });
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("[api]", error);
  return NextResponse.json({ error: message }, { status: 500 });
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("Cache-Control", "no-store");
  return res;
}
