import { NextResponse, type NextRequest } from "next/server";
import { parseReportSearch } from "@/components/reports/params";
import { env } from "@/env";
import { apiError } from "@/lib/api-utils";
import { audit } from "@/lib/audit";
import { rolesFor } from "@/lib/auth/rbac";
import { requestMeta, requireApiUser } from "@/lib/auth/session";
import { csvCell } from "@/lib/csv";
import { downtimeScopeFor, exportDowntime } from "@/server/queries/downtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPORT_CAP = 50_000;

function localTimestamp(d: Date | null, tz: string): string {
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

function hms(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

/** Downloads the filtered downtime log as CSV, scoped to the caller's locations and cameras. */
export async function GET(req: NextRequest) {
  try {
    const user = await requireApiUser(rolesFor("reports.export"));
    const tz = env.ALERT_TIMEZONE;
    const p = parseReportSearch(req.nextUrl.searchParams, tz);
    const rows = await exportDowntime(
      downtimeScopeFor(user),
      { from: p.range.from, to: p.range.to, storeId: p.storeId, entityType: p.entityType, status: p.status, search: p.search },
      EXPORT_CAP,
    );

    const header = [
      "incident_id",
      "type",
      "location",
      "location_code",
      "recorder",
      "camera",
      "channel",
      `went_offline (${tz})`,
      `came_back (${tz})`,
      "status",
      "duration_seconds",
      "duration_hms",
      "reason",
      "restore_detail",
      "caused_by_recorder",
      `offline_alert_sent (${tz})`,
      `online_alert_sent (${tz})`,
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.entityType === "DEVICE" ? "Recorder" : "Camera",
          r.storeName,
          r.storeCode,
          r.recorderName,
          r.entityType === "CAMERA" ? r.entityName : "",
          r.channel,
          localTimestamp(r.startedAt, tz),
          localTimestamp(r.endedAt, tz),
          r.endedAt ? "Resolved" : "Still offline",
          r.durationSeconds,
          hms(r.durationSeconds),
          r.startDetail,
          r.endDetail,
          r.parentIncidentId ? "yes" : "no",
          localTimestamp(r.downAlertedAt, tz),
          localTimestamp(r.upAlertedAt, tz),
        ]
          .map(csvCell)
          .join(","),
      );
    }

    const meta = await requestMeta();
    await audit({
      actor: user,
      action: "report.downtime_exported",
      entityType: "system",
      entityLabel: `downtime report ${p.range.fromDay} to ${p.range.toDay}`,
      details: {
        rows: rows.length,
        truncated: rows.length >= EXPORT_CAP,
        from: p.range.fromDay,
        to: p.range.toDay,
        storeId: p.storeId,
        entityType: p.entityType,
        status: p.status,
        search: p.search,
      },
      ...meta,
    });

    const name = p.range.fromDay === p.range.toDay ? p.range.fromDay : `${p.range.fromDay}_to_${p.range.toDay}`;
    return new NextResponse("﻿" + lines.join("\r\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="downtime-${name}.csv"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    return apiError(e);
  }
}
