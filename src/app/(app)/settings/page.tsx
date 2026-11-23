import fs from "node:fs/promises";
import path from "node:path";
import { BellRing, CheckCircle2, Database, HardDrive, Mail, Server, XCircle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { env } from "@/env";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getMailerStatus } from "@/lib/alerts/mailer";
import { getAlertSettings } from "@/lib/alerts/settings";
import { can, rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { formatBytes } from "@/lib/format";
import { mtx } from "@/lib/mediamtx/client";
import { RunHealthButton } from "@/components/health/run-health-button";
import { outboxStatsSince, recipientSummary } from "@/server/queries/alerts";

export const metadata: Metadata = { title: "System" };
export const dynamic = "force-dynamic";

async function folderSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  async function walk(d: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          bytes += (await fs.stat(p)).size;
          files += 1;
        } catch {
          // skip
        }
      }
    }
  }
  await walk(dir);
  return { bytes, files };
}

export default async function SettingsPage() {
  const user = await requireUser(rolesFor("settings.view"));

  const recordingRoot = path.resolve(/* turbopackIgnore: true */ process.cwd(), env.RECORDING_ROOT);
  const [streaming, storage, pathsCount, dbInfo, alertSettings, recipients, outbox24h] = await Promise.all([
    mtx
      .info()
      .then((i) => ({ ok: true as const, version: String(i.version) }))
      .catch((e: Error) => ({ ok: false as const, error: e.message })),
    folderSize(recordingRoot),
    mtx
      .listPaths()
      .then((p) => ({ total: p.length, online: p.filter((x) => x.online).length }))
      .catch(() => null),
    db
      .execute(sql`select version() as version, current_database() as database, pg_size_pretty(sum(pg_total_relation_size(c.oid))) as size
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = ${schema.SCHEMA_NAME} and c.relkind in ('r','i','S')`)
      .then((r) => (r.rows[0] as { version: string; database: string; size: string | null }) ?? null)
      .catch(() => null),
    // Alert tables arrive with migration 0004: degrade to "unknown" rather than failing the page.
    getAlertSettings().catch(() => null),
    recipientSummary().catch(() => null),
    outboxStatsSince(new Date(Date.now() - 24 * 3600 * 1000)).catch(() => null),
  ]);
  const mailer = getMailerStatus();

  const rows: Array<[string, React.ReactNode]> = [
    ["Control API", env.MEDIAMTX_API_URL],
    ["Playback server", env.MEDIAMTX_PLAYBACK_URL],
    ["Browser WebRTC URL", env.MEDIAMTX_PUBLIC_WEBRTC_URL],
    ["Browser HLS URL", env.MEDIAMTX_PUBLIC_HLS_URL],
    ["Health check interval", `${env.HEALTH_CHECK_INTERVAL_SECONDS}s`],
    ["Default retention", `${env.DEFAULT_RETENTION_DAYS} days`],
    ["Recording segment length", `${env.RECORD_SEGMENT_MINUTES} min`],
    ["Session lifetime", `${env.SESSION_TTL_HOURS} h`],
  ];

  return (
    <>
      <PageHeader title="System" description="Streaming server, storage and configuration overview." actions={<RunHealthButton />} />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader title="Streaming server" description="MediaMTX" />
          <CardBody>
            <div className="flex items-center gap-2 text-sm">
              {streaming.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
              <span className="font-medium">{streaming.ok ? `Connected · ${streaming.version}` : "Unreachable"}</span>
            </div>
            {!streaming.ok ? <p className="mt-2 text-[13px] text-danger">{streaming.error}</p> : null}
            {pathsCount ? (
              <p className="mt-2 text-[13px] text-muted">{pathsCount.online} of {pathsCount.total} registered streams online</p>
            ) : null}
            <p className="mt-3 text-[12px] text-faint">Start with <code className="font-mono">npm run dev</code> or <code className="font-mono">docker compose up</code>.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Local storage" description={`Not used for NVR cameras · ${recordingRoot}`} />
          <CardBody>
            <div className="flex items-center gap-2 text-sm">
              <HardDrive className="h-4 w-4 text-muted" />
              <span className="font-medium">{formatBytes(storage.bytes)}</span>
              <span className="text-faint">· {storage.files.toLocaleString()} segment files</span>
            </div>
            <p className="mt-3 text-[12px] text-faint">Footage is kept on each NVR/DVR&apos;s own disks and streamed on demand. This folder only fills if a camera is switched to local recording.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Database" description="PostgreSQL" />
          <CardBody>
            <div className="flex items-center gap-2 text-sm">
              <Database className="h-4 w-4 text-muted" />
              <span className="font-medium">{dbInfo?.database ?? "—"}</span>
              <Badge>schema {schema.SCHEMA_NAME}</Badge>
            </div>
            <p className="mt-2 text-[13px] text-muted">Schema size {dbInfo?.size ?? "—"}</p>
            <p className="mt-1 truncate text-[12px] text-faint" title={dbInfo?.version}>{dbInfo?.version?.split(",")[0] ?? ""}</p>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Notifications"
          description="Offline / back-online email alerts and the daily health report."
          action={
            can(user, "alerts.manage") ? (
              <Link href="/alerts" className={buttonClasses("secondary", "sm")}>
                <BellRing className="h-4 w-4" /> Manage alerts
              </Link>
            ) : null
          }
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-[12px] font-semibold text-muted">Mail server</p>
              <div className="mt-1 flex items-center gap-2 text-sm">
                {mailer.configured ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-warning" />}
                <span className="font-medium">{mailer.configured ? "SMTP configured" : "SMTP not configured"}</span>
              </div>
              <p className="mt-1 truncate font-mono text-[12px] text-faint" title={mailer.host ?? ""}>
                {mailer.configured ? `${mailer.host}:${env.SMTP_PORT}${env.SMTP_SECURE ? " (TLS)" : ""}` : "Set SMTP_HOST and SMTP_FROM in .env"}
              </p>
            </div>
            <div>
              <p className="text-[12px] font-semibold text-muted">Sender</p>
              <div className="mt-1 flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted" />
                <span className="truncate font-medium" title={mailer.from ?? ""}>{mailer.from ?? "—"}</span>
              </div>
            </div>
            <div>
              <p className="text-[12px] font-semibold text-muted">Alerts</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
                {alertSettings ? (
                  <>
                    <Badge tone={alertSettings.alertsEnabled ? "success" : "neutral"}>{alertSettings.alertsEnabled ? "On" : "Off"}</Badge>
                    <span className="text-[13px] text-muted">after {alertSettings.offlineGraceMinutes} min offline</span>
                  </>
                ) : (
                  <span className="text-[13px] text-faint">Unavailable</span>
                )}
              </div>
              <p className="mt-1 text-[12px] text-faint">
                {alertSettings
                  ? alertSettings.dailyReportEnabled
                    ? `Daily report at ${String(alertSettings.dailyReportHour).padStart(2, "0")}:00 ${env.ALERT_TIMEZONE}`
                    : "Daily report off"
                  : "Run database migrations to enable alerts"}
              </p>
            </div>
            <div>
              <p className="text-[12px] font-semibold text-muted">Recipients · last 24 h</p>
              <p className="mt-1 text-sm">
                <span className="font-medium tabular-nums">{recipients ? recipients.active : "—"}</span>
                <span className="text-[13px] text-muted"> active recipient{recipients?.active === 1 ? "" : "s"}</span>
              </p>
              <p className="mt-1 text-[12px] text-faint tabular-nums">
                {outbox24h
                  ? `${outbox24h.SENT} sent · ${outbox24h.FAILED} failed · ${outbox24h.QUEUED} queued${outbox24h.SKIPPED_NO_SMTP ? ` · ${outbox24h.SKIPPED_NO_SMTP} held (no SMTP)` : ""}`
                  : "—"}
              </p>
            </div>
          </div>
          {!mailer.configured ? (
            <p className="mt-4 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning">
              Without SMTP, alerts and daily reports are still generated and kept in the outbox on the Alerts page, but nothing is emailed.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card className="mt-5">
        <CardHeader title="Configuration" description="Values come from the .env file; restart the server after changing them." />
        <CardBody>
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 border-b border-border py-2">
                <dt className="text-muted">{k}</dt>
                <dd className="truncate font-mono text-[13px] text-text">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-[13px] text-muted">
            <Server className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              When users open the console from other machines, set the browser URLs above to the server&apos;s LAN address (for example
              <code className="mx-1 font-mono">http://192.168.1.10:8889</code>) so WebRTC and HLS can reach the streaming server.
            </p>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
