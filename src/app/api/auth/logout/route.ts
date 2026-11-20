import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { clearSessionCookie, getCurrentUser, requestMeta } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (user) {
    const meta = await requestMeta();
    await audit({ actor: user, action: "auth.logout", entityType: "user", entityId: user.id, ...meta });
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
