import { AlertTriangle, BellRing, Camera, Clock, FileDown, HardDrive, Timer, Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { KpiTile } from "@/components/dashboard/kpi-tile";
import {
  DailyReportFrame,
  DailyReportPreviewCard,
  DailyReportRestricted,
  DailyReportSkeleton,
} from "@/components/reports/daily-report-preview";
import { DowntimeTable } from "@/components/reports/downtime-table";
import { addDays, dayKeyInTz, formatDurationShort, isDayKey } from "@/components/reports/format";
import { OfflineNowCard } from "@/components/reports/offline-now-card";
import { parseReportSearch, reportQuery, toReportSearch } from "@/components/reports/params";
import { ReportFilters } from "@/components/reports/report-filters";
import { UnstableCamerasCard } from "@/components/reports/unstable-cameras-card";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { env } from "@/env";
import { can, rolesFor, storeScope } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import {
  downtimeKpis,
  downtimeScopeFor,
  firstIncidentAt,
  listDowntime,
  listOpenIncidents,
  monitoringCoverage,
  mostUnstableCameras,
  type DowntimeFilter,
} from "@/server/queries/downtime";
import { storeOptionsForUser } from "@/server/queries/stores";

export const metadata: Metadata = { title: "Downtime reports" };
export const dynamic = "force-dynamic";

const OPEN_PANEL_LIMIT = 25;

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser(rolesFor("reports.view"));
  const tz = env.ALERT_TIMEZONE;
  const values = toReportSearch(await searchParams);
  const parsed = parseReportSearch(values as Record<string, string | undefined>, tz);
  const scope = downtimeScopeFor(user);

  const filter: DowntimeFilter = {
    from: parsed.range.from,
    to: parsed.range.to,
    storeId: parsed.storeId,
    entityType: parsed.entityType,
    status: parsed.status,
    search: parsed.search,
  };

  const today = dayKeyInTz(new Date(), tz);
  const yesterday = addDays(today, -1);
  const day = isDayKey(values.day) && values.day <= today ? values.day : yesterday;
  // The preview honours store and camera-level limits, so anyone with at least one location may see it.
  const previewAllowed = user.isAdmin || user.storeIds.length > 0;

  const [kpis, page, openNow, unstable, storeOptions, coverage, historySince] = await Promise.all([
    downtimeKpis(scope, filter),
    listDowntime(scope, { ...filter, page: parsed.page, pageSize: 25 }),
    // The open-incident query has no type filter: over-fetch when one is set, then trim.
    listOpenIncidents(scope, { storeId: parsed.storeId, limit: parsed.entityType ? 500 : OPEN_PANEL_LIMIT }),
    mostUnstableCameras(scope, filter, 10),
    storeOptionsForUser(user),
    monitoringCoverage(scope, parsed.storeId),
    firstIncidentAt(scope),
  ]);

  const openNowFiltered = (parsed.entityType ? openNow.filter((r) => r.entityType === parsed.entityType) : openNow).slice(0, OPEN_PANEL_LIMIT);
  // Already limited to the location and type filters (but not the date range or search).
  const openTotal = kpis.currentlyOffline;

  const exportQs = reportQuery(values, { page: undefined, day: undefined });
  const pageHref = (p: number) => `/reports?${reportQuery(values, { page: String(p) })}`;

  const monitored = coverage.filter((c) => c.mode === "DIRECT" || c.mode === "RELAY").reduce((n, c) => n + c.recorders, 0);
  const notMonitored = coverage.filter((c) => c.mode === "PENDING_NETWORK" || c.mode === "CLOUD_ONLY").reduce((n, c) => n + c.recorders, 0);

  return (
    <>
      <PageHeader
        title="Downtime reports"
        description="Every period a camera or recorder was offline: when it went down, when it came back, how long, and whether an alert went out. Times in India Standard Time."
        actions={
          <>
            {can(user, "alerts.manage") ? (
              <Link href="/alerts" className={buttonClasses("ghost")}>
                <BellRing className="h-4 w-4" /> Alert settings
              </Link>
            ) : null}
            {can(user, "reports.export") ? (
              <a href={`/api/reports/downtime.csv${exportQs ? `?${exportQs}` : ""}`} className={buttonClasses("secondary")}>
                <FileDown className="h-4 w-4" /> Export CSV
              </a>
            ) : null}
          </>
        }
      />

      <ReportFilters key={reportQuery(values, { page: undefined, day: undefined })} values={values} preset={parsed.range.preset} fromDay={parsed.range.fromDay} toDay={parsed.range.toDay} stores={storeOptions} />

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        <span>
          <span className="font-semibold text-text">{parsed.range.label}</span>
          {parsed.range.toDay === today ? " · up to now" : null}
        </span>
        <span>
          {monitored} recorder{monitored === 1 ? "" : "s"} monitored
          {notMonitored > 0 ? ` · ${notMonitored} awaiting network or cloud-only (not tracked)` : ""}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Incidents" value={kpis.incidents.toLocaleString()} icon={<AlertTriangle className="h-4 w-4" />} tone={kpis.incidents > 0 ? "warning" : "default"} hint={`${kpis.alertsSent.toLocaleString()} alerted by email`} />
        <KpiTile label="Total downtime" value={formatDurationShort(kpis.totalDowntimeSeconds)} icon={<Clock className="h-4 w-4" />} hint="Clipped to the selected range" />
        <KpiTile label="Cameras affected" value={kpis.camerasAffected.toLocaleString()} icon={<Camera className="h-4 w-4" />} hint="Distinct cameras" />
        <KpiTile label="Recorders affected" value={kpis.recordersAffected.toLocaleString()} icon={<HardDrive className="h-4 w-4" />} hint="Distinct NVRs / DVRs" />
        <KpiTile
          label="Currently offline"
          value={openTotal.toLocaleString()}
          icon={<Timer className="h-4 w-4" />}
          tone={openTotal > 0 ? "danger" : "success"}
          hint={`${kpis.currentlyOfflineCameras} cameras · ${kpis.currentlyOfflineRecorders} recorders`}
        />
        <KpiTile label="MTTR" value={kpis.mttrSeconds === null ? "—" : formatDurationShort(kpis.mttrSeconds)} icon={<Wrench className="h-4 w-4" />} hint="Mean time to recover" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-w-0 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-[15px] font-semibold text-text">Downtime log</h2>
            <span className="text-[12px] text-faint">Newest first</span>
          </div>
          <DowntimeTable page={page} timeZone={tz} pageHref={pageHref} historySince={historySince} />
        </Card>
        <div className="space-y-5">
          <OfflineNowCard items={openNowFiltered} total={openTotal} timeZone={tz} />
          <UnstableCamerasCard items={unstable} timeZone={tz} />
        </div>
      </div>

      <div className="mt-5">
        <DailyReportPreviewCard day={day} maxDay={today} values={values}>
          {previewAllowed ? (
            <Suspense key={day} fallback={<DailyReportSkeleton />}>
              <DailyReportFrame day={day} timeZone={tz} storeIds={storeScope(user)} cameraScope={user.isAdmin ? undefined : user.cameraScope} />
            </Suspense>
          ) : (
            <DailyReportRestricted />
          )}
        </DailyReportPreviewCard>
      </div>
    </>
  );
}
