import { NextResponse, type NextRequest } from "next/server";
import { apiError } from "@/lib/api-utils";
import { rolesFor } from "@/lib/auth/rbac";
import { requireApiUser } from "@/lib/auth/session";
import { csvCell } from "@/lib/csv";
import { exportAuditLogs } from "@/server/queries/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Downloads the filtered audit trail as CSV (administrators only). */
export async function GET(req: NextRequest) {
  try {
    const user = await requireApiUser(rolesFor("audit.export"));
    const sp = req.nextUrl.searchParams;
    const rows = await exportAuditLogs(user, {
      action: sp.get("action"),
      actor: sp.get("actor"),
      entityType: sp.get("entityType"),
      search: sp.get("q"),
      from: sp.get("from") ? new Date(sp.get("from") as string) : null,
      to: sp.get("to") ? new Date(sp.get("to") as string) : null,
    });
    const header = ["id", "time", "actor", "action", "entityType", "entityId", "entityLabel", "ip", "userAgent", "details"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([r.id, r.createdAt, r.actorEmail, r.action, r.entityType, r.entityId, r.entityLabel, r.ip, r.userAgent, r.details].map(csvCell).join(","));
    }
    const body = "﻿" + lines.join("\r\n");
    return new NextResponse(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return apiError(e);
  }
}
