import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { mtx } from "@/lib/mediamtx/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unauthenticated liveness/readiness probe for load balancers and Docker health checks. */
export async function GET() {
  const checks: Record<string, "ok" | "fail"> = {};
  try {
    await db.execute(sql`select 1`);
    checks.database = "ok";
  } catch {
    checks.database = "fail";
  }
  try {
    await mtx.info();
    checks.streaming = "ok";
  } catch {
    checks.streaming = "fail";
  }
  const healthy = checks.database === "ok";
  return NextResponse.json({ status: healthy ? "ok" : "degraded", checks, time: new Date().toISOString() }, { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } });
}
