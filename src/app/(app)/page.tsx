import { AlertTriangle, Camera, CheckCircle2, Clock, HardDrive, ShieldAlert, Users, WifiOff, XCircle } from "lucide-react";
import Link from "next/link";
import { AvailabilityChart } from "@/components/dashboard/availability-chart";
import { RunHealthButton } from "@/components/health/run-health-button";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader, StatTile } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { cn, formatDateTime, formatRelative, humanAction } from "@/lib/format";
import { CLOCK_WARN_SECONDS, loadDashboard, type DashboardSite } from "@/server/queries/dashboard";

export const dynamic = "force-dynamic";

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const user = await requireUser();
  const { denied } = await searchParams;
  const d = await loadDashboard(user);
  const c = d.cameras;
  const r = d.recorders;
  const onlineShare = pct(c.online, c.enabled);
  const lastCheck = d.recorderList.map((x) => x.lastCheckedAt).filter(Boolean).sort().at(-1) ?? null;
  const alerts = r.offline + r.diskIssues + r.clockIssues;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={lastCheck ? `Last health check ${formatRelative(lastCheck)} · ${c.enabled} cameras on ${r.total} recorders` : "Health checks start a few seconds after the server boots."}
        actions={
          <>
            {can(user, "health.run") ? <RunHealthButton /> : null}
            <Link href="/live" className={buttonClasses("primary")}>
              Open live view
            </Link>
          </>
        }
      />

      {denied ? <Banner tone="warning" icon={<ShieldAlert className="h-4 w-4" />} title="You do not have permission to open that page." /> : null}
      {!d.streaming.reachable ? (
        <Banner tone="danger" icon={<WifiOff className="h-4 w-4" />} title="Streaming server unreachable" text="Live view and playback are paused. Camera and recorder health still come from the recorders. Start it with npm run dev (or npm run mediamtx on its own)." />
      ) : null}

      {/* KPI row */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Cameras online"
          value={
            <>
              {c.online}
              <span className="text-lg font-normal text-faint"> / {c.enabled}</span>
            </>
          }
          hint={`${c.offline} offline${c.unknown ? ` · ${c.unknown} unknown` : ""}${c.disabled ? ` · ${c.disabled} disabled` : ""}`}
          tone={c.offline > 0 ? "warning" : "success"}
          icon={<Camera className="h-5 w-5" />}
        />
        <StatTile
          label="NVR / DVR online"
          value={
            <>
              {r.online}
              <span className="text-lg font-normal text-faint"> / {r.total}</span>
            </>
          }
          hint={`${r.nvr} NVR · ${r.dvr} DVR${r.offline ? ` · ${r.offline} offline` : " · all reachable"}`}
          tone={r.offline > 0 ? "danger" : "success"}
          icon={<HardDrive className="h-5 w-5" />}
        />
        <StatTile
          label="Camera availability (24h)"
          value={d.availability.cameras24h == null ? "—" : `${d.availability.cameras24h}%`}
          hint={onlineShare == null ? "No cameras yet" : `${onlineShare}% online right now`}
          tone="accent"
          icon={<CheckCircle2 className="h-5 w-5" />}
        />
        <StatTile
          label="Recorder alerts"
          value={alerts}
          hint={alerts ? [r.offline && `${r.offline} offline`, r.diskIssues && `${r.diskIssues} disk`, r.clockIssues && `${r.clockIssues} clock`].filter(Boolean).join(" · ") : "Disks and clocks healthy"}
          tone={alerts ? "danger" : "success"}
          icon={<AlertTriangle className="h-5 w-5" />}
        />
      </div>

      {/* Trend + status mix */}
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Availability, last 24 hours" description="Share of time cameras and recorders were online, per hour." />
          <CardBody>
            <AvailabilityChart
              series={[
                { key: "cameras", label: "Cameras", color: "var(--chart-1)", points: d.availability.cameraSeries },
                { key: "recorders", label: "Recorders", color: "var(--chart-2)", points: d.availability.recorderSeries },
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Camera status" description={`${c.total} cameras`} action={<Link href="/health" className="text-sm text-accent hover:underline">Details</Link>} />
          <CardBody>
            <SegmentedBar
              parts={[
                { label: "Online", value: c.online, color: "var(--chart-online)" },
                { label: "Offline", value: c.offline, color: "var(--chart-offline)" },
                { label: "Unknown", value: c.unknown, color: "var(--chart-unknown)" },
                { label: "Disabled", value: c.disabled, color: "var(--chart-muted)" },
              ]}
            />
            <p className="mb-2 mt-5 text-[12px] font-semibold uppercase tracking-wide text-faint">Offline now</p>
            {d.offlineCameras.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <CheckCircle2 className="h-4 w-4 text-success" /> Every enabled camera is online.
              </p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {d.offlineCameras.map((o) => (
                  <li key={o.id}>
                    <Link href={`/live/${o.id}`} className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-2">
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-text group-hover:text-accent">{o.name}</span>
                        <span className="block truncate text-[11px] text-faint" title={o.detail ?? ""}>
                          {o.recorder ?? o.site}
                          {o.detail ? ` · ${o.detail.replace(/^Recorder reports channel \d+ /, "")}` : ""}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Recorders */}
      <Card className="mt-4 overflow-hidden">
        <CardHeader title="NVR / DVR status" description="Reachability, channels, disks and clock of every recorder." action={<Link href="/devices" className="text-sm text-accent hover:underline">Manage recorders</Link>} />
        {d.recorderList.length === 0 ? (
          <CardBody>
            <EmptyState icon={<HardDrive className="h-5 w-5" />} title="No recorders yet" description="Add an NVR or DVR on the Recorders page and import its channels." />
          </CardBody>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Recorder</TH>
                <TH>Status</TH>
                <TH>Cameras online</TH>
                <TH>Disks</TH>
                <TH>Clock</TH>
                <TH>Uptime 24h</TH>
                <TH>Checked</TH>
              </tr>
            </THead>
            <TBody>
              {d.recorderList.map((x) => {
                const share = pct(x.onlineCameraCount, x.cameraCount);
                const drift = x.clockDriftSeconds ?? 0;
                return (
                  <TR key={x.id}>
                    <TD>
                      <Link href={`/cameras?device=${x.id}`} className="font-medium text-text hover:text-accent">
                        {x.name}
                      </Link>
                      <p className="text-[12px] text-faint">
                        {x.kind} · {x.site} · <span className="font-mono">{x.host}</span>
                        {x.model ? ` · ${x.model}` : ""}
                      </p>
                    </TD>
                    <TD>
                      <StatusBadge status={x.status} enabled={x.isEnabled} />
                    </TD>
                    <TD className="min-w-44">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--chart-offline-soft)]">
                          <div className="h-full rounded-full bg-[var(--chart-online)] transition-[width] duration-700" style={{ width: `${share ?? 0}%` }} />
                        </div>
                        <span className="text-[13px] tabular-nums text-text">
                          {x.onlineCameraCount}/{x.cameraCount}
                        </span>
                      </div>
                    </TD>
                    <TD className="text-[13px]">
                      {x.storageStatus == null ? (
                        <span className="text-faint">—</span>
                      ) : x.storageHealthy ? (
                        <span className="inline-flex items-center gap-1.5 text-text">
                          <CheckCircle2 className="h-3.5 w-3.5 text-success" /> {x.storageStatus}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-medium text-danger">
                          <AlertTriangle className="h-3.5 w-3.5" /> {x.storageStatus}
                        </span>
                      )}
                    </TD>
                    <TD className="text-[13px]">
                      {x.clockDriftSeconds == null ? (
                        <span className="text-faint">—</span>
                      ) : Math.abs(drift) >= CLOCK_WARN_SECONDS ? (
                        <span className="inline-flex items-center gap-1.5 text-warning" title="Playback is corrected automatically; fix the recorder's NTP setting to remove the offset.">
                          <Clock className="h-3.5 w-3.5" /> {Math.round(Math.abs(drift) / 60)} min {drift > 0 ? "fast" : "slow"}
                        </span>
                      ) : (
                        <span className="text-muted">In sync</span>
                      )}
                    </TD>
                    <TD className="text-[13px] tabular-nums">{x.uptime24h == null ? "—" : `${x.uptime24h}%`}</TD>
                    <TD className="text-[13px] text-muted">{formatRelative(x.lastCheckedAt)}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      {/* Sites + events */}
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Cameras by site" description="Online and offline cameras per store, office and warehouse." />
          <CardBody>
            <SiteBars sites={d.sites} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent status changes" action={<Link href="/health" className="text-sm text-accent hover:underline">Health</Link>} />
          <CardBody>
            {d.events.length === 0 ? (
              <p className="text-sm text-muted">No status changes recorded yet.</p>
            ) : (
              <ol className="relative space-y-3 border-l border-border pl-4">
                {d.events.map((e) => (
                  <li key={e.id} className="relative">
                    <span
                      className={cn(
                        "absolute -left-[21px] top-1 grid h-2.5 w-2.5 place-items-center rounded-full ring-4 ring-[var(--surface)]",
                        e.status === "ONLINE" ? "bg-[var(--chart-online)]" : e.status === "OFFLINE" ? "bg-[var(--chart-offline)]" : "bg-[var(--chart-unknown)]",
                      )}
                    />
                    <p className="text-[13px] text-text">
                      {e.kind === "recorder" ? <HardDrive className="mr-1 inline h-3.5 w-3.5 text-muted" /> : null}
                      <Link href={e.kind === "camera" ? `/live/${e.targetId}` : `/cameras?device=${e.targetId}`} className="font-medium hover:text-accent">
                        {e.name}
                      </Link>{" "}
                      <span className="text-muted">{e.status === "ONLINE" ? "came online" : e.status === "OFFLINE" ? "went offline" : "status unknown"}</span>
                    </p>
                    <p className="text-[11px] text-faint" title={formatDateTime(e.at)}>
                      {e.site} · {formatRelative(e.at)}
                      {e.detail && e.status !== "ONLINE" ? ` · ${e.detail}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      </div>

      {user.isAdmin ? (
        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <Card>
            <CardHeader title="Security, last 24 hours" />
            <CardBody className="grid grid-cols-2 gap-3">
              <div className="rounded-md bg-surface-2 p-3">
                <p className="flex items-center gap-1.5 text-[12px] text-faint">
                  <Users className="h-3.5 w-3.5" /> Active users
                </p>
                <p className="mt-1 text-2xl font-semibold">{d.security.activeUsers24h}</p>
              </div>
              <div className="rounded-md bg-surface-2 p-3">
                <p className="flex items-center gap-1.5 text-[12px] text-faint">
                  <ShieldAlert className="h-3.5 w-3.5" /> Failed sign-ins
                </p>
                <p className={cn("mt-1 text-2xl font-semibold", d.security.loginFailures24h > 10 && "text-danger")}>{d.security.loginFailures24h}</p>
              </div>
            </CardBody>
          </Card>
          <Card className="xl:col-span-2">
            <CardHeader title="Latest activity" action={<Link href="/audit" className="text-sm text-accent hover:underline">Audit log</Link>} />
            <CardBody>
              {d.recentAudit.length === 0 ? (
                <p className="text-sm text-muted">No activity recorded yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {d.recentAudit.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-4 py-2 text-[13px]">
                      <p className="min-w-0 truncate">
                        <span className="font-medium text-text">{a.actorEmail ?? "system"}</span>
                        <span className="text-muted"> {humanAction(a.action)}</span>
                        {a.entityLabel ? <span className="text-text"> {a.entityLabel}</span> : null}
                      </p>
                      <span className="shrink-0 text-[12px] text-faint" title={formatDateTime(a.createdAt)}>
                        {formatRelative(a.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}
    </>
  );
}

function Banner({ tone, icon, title, text }: { tone: "danger" | "warning"; icon: React.ReactNode; title: string; text?: string }) {
  return (
    <div className={cn("mb-4 flex items-start gap-3 rounded-md border px-4 py-3 text-sm fade-in", tone === "danger" ? "border-danger/30 bg-danger-soft text-danger" : "border-warning/30 bg-warning-soft text-warning")}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>
        <p className="font-medium">{title}</p>
        {text ? <p className="text-[13px] opacity-90">{text}</p> : null}
      </div>
    </div>
  );
}

/** One whole at a glance: a tall segmented bar with the share printed inside wide blocks. */
function SegmentedBar({ parts }: { parts: Array<{ label: string; value: number; color: string }> }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="flex h-7 w-full gap-0.5 overflow-hidden rounded" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
        {total === 0 ? <div className="h-full w-full rounded bg-surface-2" /> : null}
        {shown.map((p) => {
          const share = (p.value / total) * 100;
          return (
            <div
              key={p.label}
              className="flex h-full items-center px-2 text-[12px] font-semibold text-white transition-[width] duration-700 first:rounded-l last:rounded-r"
              style={{ width: `${share}%`, background: p.color }}
              title={`${p.label}: ${p.value} (${Math.round(share)}%)`}
            >
              {share >= 14 ? `${Math.round(share)}%` : ""}
            </div>
          );
        })}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px]">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-muted">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
              {p.label}
            </span>
            <span className="font-semibold text-text">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Horizontal stacked bars per site (online / offline / unknown), worst first. */
function SiteBars({ sites }: { sites: DashboardSite[] }) {
  if (sites.length === 0) return <p className="text-sm text-muted">No sites assigned to you.</p>;
  const max = Math.max(1, ...sites.map((s) => s.total));
  const kindLabel = { STORE: "Store", CORPORATE: "Corporate", WAREHOUSE: "Warehouse" } as const;
  return (
    <div>
      <div className="mb-3 flex gap-4 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--chart-online)]" /> Online
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--chart-offline)]" /> Offline
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[var(--chart-unknown)]" /> Unknown
        </span>
      </div>
      <ul className="space-y-3">
        {sites.map((s) => (
          <li key={s.id}>
            <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
              <Link href={`/live?store=${s.id}`} className="inline-flex min-w-0 items-center gap-2 font-medium text-text hover:text-accent">
                <span className="truncate">{s.name}</span>
                <Badge>{kindLabel[s.kind]}</Badge>
              </Link>
              <span className="shrink-0 tabular-nums text-muted">
                <span className="font-semibold text-text">{s.online}</span>/{s.total}
                {s.offline ? <span className="ml-2 text-danger">{s.offline} offline</span> : null}
              </span>
            </div>
            <div className="flex h-3 gap-0.5" style={{ width: `${Math.max(6, (s.total / max) * 100)}%` }}>
              {s.total === 0 ? <div className="h-full w-full rounded-sm bg-surface-2" title="No cameras" /> : null}
              {[
                { v: s.online, c: "var(--chart-online)", l: "online" },
                { v: s.offline, c: "var(--chart-offline)", l: "offline" },
                { v: s.unknown, c: "var(--chart-unknown)", l: "unknown" },
              ]
                .filter((p) => p.v > 0)
                .map((p) => (
                  <div key={p.l} className="h-full rounded-sm transition-[width] duration-700" style={{ width: `${(p.v / s.total) * 100}%`, background: p.c }} title={`${s.name}: ${p.v} ${p.l}`} />
                ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
