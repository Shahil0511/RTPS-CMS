import { Eye, Lock } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buildDailyReport } from "@/lib/alerts/reports";
import { formatDayKey, formatDurationShort, middayInTz } from "./format";
import { REPORT_PARAM_KEYS, type ReportSearch } from "./params";

/** Shell with the day picker; the report itself streams in via <DailyReportFrame>. */
export function DailyReportPreviewCard({
  day,
  maxDay,
  values,
  children,
}: {
  day: string;
  maxDay: string;
  values: ReportSearch;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Daily report preview"
        description={`Exactly what recipients get for ${formatDayKey(day)}. Previewing sends nothing.`}
        action={
          <form method="get" action="/reports" className="flex items-center gap-2">
            {REPORT_PARAM_KEYS.filter((k) => k !== "day" && values[k]).map((k) => (
              <input key={k} type="hidden" name={k} value={values[k]} />
            ))}
            <Input type="date" name="day" defaultValue={day} max={maxDay} aria-label="Report day" className="w-[150px]" />
            <Button type="submit" variant="secondary">
              <Eye className="h-4 w-4" /> Preview
            </Button>
          </form>
        }
      />
      <CardBody>{children}</CardBody>
    </Card>
  );
}

export async function DailyReportFrame({
  day,
  timeZone,
  storeIds,
  cameraScope,
}: {
  day: string;
  timeZone: string;
  storeIds: string[] | null;
  /** Camera-level limits of the viewer (SessionUser.cameraScope); omitted for admins. */
  cameraScope?: Record<string, string[]>;
}) {
  let report: Awaited<ReturnType<typeof buildDailyReport>>;
  try {
    report = await buildDailyReport({ date: middayInTz(day, timeZone), storeIds, cameraScope });
  } catch (e) {
    console.error("[reports] daily report preview failed", e);
    return <p className="rounded-[6px] bg-danger-soft px-3 py-2 text-[13px] text-danger">The report could not be built. Check the server log for details.</p>;
  }
  const s = report.summary;
  const facts: Array<[string, string]> = [
    ["Incidents", s.incidents.toLocaleString()],
    ["Cameras affected", s.camerasAffected.toLocaleString()],
    ["Recorders affected", s.devicesAffected.toLocaleString()],
    ["Still offline", s.stillOffline.toLocaleString()],
    ["Total downtime", formatDurationShort(s.totalDowntimeSeconds)],
  ];
  return (
    <div className="fade-in">
      <p className="mb-2 truncate text-[13px] text-muted">
        <span className="font-semibold text-text">Subject:</span> {report.subject}
      </p>
      <dl className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
        {facts.map(([k, v]) => (
          <div key={k} className="flex gap-1.5">
            <dt>{k}</dt>
            <dd className="font-semibold text-text tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {/* sandbox="" : no scripts, forms, navigation or same-origin access from the email HTML. */}
      <iframe title={`Daily report ${day}`} sandbox="" srcDoc={report.html} className="h-[70vh] w-full rounded-[6px] border border-border bg-white" />
    </div>
  );
}

export function DailyReportRestricted() {
  return (
    <p className="flex items-start gap-2 rounded-[6px] bg-surface-2 px-3 py-2.5 text-[13px] text-muted">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" />
      No locations are assigned to your account, so there is no daily report to preview. Ask an administrator for access.
    </p>
  );
}

export function DailyReportSkeleton() {
  return (
    <div>
      <div className="skeleton mb-2 h-4 w-2/3" />
      <div className="skeleton mb-3 h-3 w-1/2" />
      <div className="skeleton h-[40vh] w-full" />
    </div>
  );
}
