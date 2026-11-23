import "server-only";
import type { SiteKind } from "@/db/schema";
import { env } from "@/env";
import { formatDowntime, formatInZone, type DayRange } from "./time";

/**
 * Email templates for offline/restore alerts and the daily health report.
 * HTML uses tables and inline styles only (Outlook/Gmail safe); every message
 * also has a plain-text body. Nothing here may contain credentials or hosts' secrets.
 */

const BRAND = "Libas CCTV";

const C = {
  ink: "#172B4D",
  subtle: "#5E6C84",
  border: "#DFE1E6",
  surface: "#FFFFFF",
  canvas: "#F4F5F7",
  header: "#0052CC",
  danger: "#DE350B",
  dangerBg: "#FFEBE6",
  success: "#00875A",
  successBg: "#E3FCEF",
  warning: "#FF8B00",
  warningBg: "#FFFAE6",
  neutralBg: "#F4F5F7",
} as const;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(s: string | number | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const tz = () => env.ALERT_TIMEZONE;
const appUrl = (path: string) => `${env.APP_URL.replace(/\/+$/, "")}${path}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function siteKindLabel(kind: SiteKind | null | undefined): string {
  switch (kind) {
    case "CORPORATE":
      return "Corporate office";
    case "WAREHOUSE":
      return "Warehouse";
    case "STORE":
      return "Store";
    default:
      return "Location";
  }
}

export interface AlertLocation {
  storeId: string | null;
  name: string;
  code: string | null;
  kind: SiteKind | null;
}

/** One line of an alert email: a recorder (with its cameras folded in) or a single camera. */
export interface AlertEvent {
  type: "OFFLINE" | "RESTORED";
  entityType: "CAMERA" | "DEVICE";
  incidentId: number;
  location: AlertLocation;
  cameraId: string | null;
  deviceId: string | null;
  cameraName: string | null;
  channel: number | null;
  recorderName: string | null;
  startedAt: Date;
  endedAt: Date | null;
  /** OFFLINE: so far; RESTORED: total. */
  downtimeSeconds: number;
  detail: string | null;
  /** DEVICE only: cameras on the recorder that are affected. */
  affectedCameras?: number;
  affectedCameraNames?: string[];
  /** RESTORED DEVICE only: cameras that are still offline after the recorder came back. */
  stillOfflineCameras?: number;
  /** RESTORED DEVICE only: names of those cameras (each is then alerted on its own after the grace period). */
  stillOfflineCameraNames?: string[];
}

function cameraLabel(e: Pick<AlertEvent, "cameraName" | "channel" | "cameraId">): string {
  const name = e.cameraName ?? "Camera";
  if (e.channel) return `${name} (channel ${e.channel})`;
  return e.cameraId ? `${name} (ID ${e.cameraId.slice(0, 8)})` : name;
}

function entityTitle(e: AlertEvent): string {
  if (e.entityType === "DEVICE") return `Recorder ${e.recorderName ?? "(unnamed)"}`;
  return `Camera ${cameraLabel(e)}`;
}

function entitySub(e: AlertEvent): string {
  if (e.entityType === "DEVICE") {
    const n = e.affectedCameras ?? 0;
    const base = e.type === "OFFLINE" ? `${plural(n, "camera")} affected` : `${plural(n, "camera")} on this recorder`;
    const still = e.type === "RESTORED" && e.stillOfflineCameras ? `; ${plural(e.stillOfflineCameras, "camera")} still offline` : "";
    return base + still;
  }
  return e.recorderName ? `On recorder ${e.recorderName}` : "Standalone camera";
}

function locationLine(l: AlertLocation): string {
  return `${l.name} (${siteKindLabel(l.kind)}${l.code ? `, ${l.code}` : ""})`;
}

function groupByLocation<T extends { location: AlertLocation }>(items: T[]): Array<{ location: AlertLocation; items: T[] }> {
  const map = new Map<string, { location: AlertLocation; items: T[] }>();
  for (const it of items) {
    const key = it.location.storeId ?? `name:${it.location.name}`;
    const g = map.get(key) ?? { location: it.location, items: [] };
    g.items.push(it);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.location.name.localeCompare(b.location.name));
}

/** "Recorder NVR-1 (24 cameras)", "3 cameras", "2 recorders, 5 cameras". */
function describe(events: AlertEvent[]): string {
  const devs = events.filter((e) => e.entityType === "DEVICE");
  const cams = events.filter((e) => e.entityType === "CAMERA");
  if (devs.length === 1 && cams.length === 0) {
    const d = devs[0]!;
    return `Recorder ${d.recorderName ?? ""} (${plural(d.affectedCameras ?? 0, "camera")})`.replace("  ", " ");
  }
  if (devs.length === 0 && cams.length === 1) return `Camera ${cameraLabel(cams[0]!)}`;
  const parts: string[] = [];
  if (devs.length) parts.push(plural(devs.length, "recorder"));
  if (cams.length) parts.push(plural(cams.length, "camera"));
  return parts.join(", ");
}

function where(events: AlertEvent[]): string {
  const groups = groupByLocation(events);
  if (groups.length === 1) return ` at ${groups[0]!.location.name}`;
  return ` across ${groups.length} locations`;
}

// ---------------------------------------------------------------------------
// HTML building blocks
// ---------------------------------------------------------------------------
function pill(text: string, tone: "danger" | "success" | "warning" | "neutral"): string {
  const map = {
    danger: [C.danger, C.dangerBg],
    success: [C.success, C.successBg],
    warning: [C.warning, C.warningBg],
    neutral: [C.subtle, C.neutralBg],
  } as const;
  const [fg, bg] = map[tone];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:3px;background:${bg};color:${fg};font-size:11px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;white-space:nowrap;">${escapeHtml(text)}</span>`;
}

function layout(opts: { preheader: string; title: string; subtitle: string; accent: string; body: string; cta: { label: string; href: string } }): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;padding:0;background:${C.canvas};font-family:${FONT};color:${C.ink};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.canvas}" style="background:${C.canvas};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;background:${C.surface};border:1px solid ${C.border};border-radius:6px;border-collapse:separate;">
<tr><td bgcolor="${C.header}" style="background:${C.header};padding:14px 24px;border-radius:6px 6px 0 0;color:#FFFFFF;font-size:13px;font-weight:700;letter-spacing:0.3px;">${BRAND} &middot; Camera health</td></tr>
<tr><td style="padding:20px 24px 8px 24px;border-top:4px solid ${opts.accent};">
<div style="font-size:20px;line-height:26px;font-weight:700;color:${C.ink};">${escapeHtml(opts.title)}</div>
<div style="font-size:13px;line-height:20px;color:${C.subtle};padding-top:4px;">${escapeHtml(opts.subtitle)}</div>
</td></tr>
<tr><td style="padding:8px 24px 8px 24px;">${opts.body}</td></tr>
<tr><td style="padding:8px 24px 24px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${C.header}" style="background:${C.header};border-radius:3px;">
<a href="${escapeHtml(opts.cta.href)}" style="display:inline-block;padding:9px 16px;font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;">${escapeHtml(opts.cta.label)}</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid ${C.border};font-size:11px;line-height:16px;color:${C.subtle};">
Automated message from the ${BRAND} monitoring system. Times are shown in ${escapeHtml(tz())}. Manage recipients under Alerts in the app.
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

const TH = `style="padding:8px 10px;border-bottom:2px solid ${C.border};font-size:11px;font-weight:700;color:${C.subtle};text-transform:uppercase;letter-spacing:0.4px;text-align:left;"`;
const TD = `style="padding:9px 10px;border-bottom:1px solid ${C.border};font-size:13px;line-height:18px;color:${C.ink};vertical-align:top;"`;
const TD_MUTED = `style="padding:9px 10px;border-bottom:1px solid ${C.border};font-size:12px;line-height:18px;color:${C.subtle};vertical-align:top;"`;

function locationHeading(l: AlertLocation, right = ""): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;"><tr>
<td style="padding:6px 0;font-size:14px;font-weight:700;color:${C.ink};">${escapeHtml(l.name)} <span style="font-weight:400;color:${C.subtle};font-size:12px;">&nbsp;${escapeHtml(siteKindLabel(l.kind))}${l.code ? ` &middot; ${escapeHtml(l.code)}` : ""}</span></td>
<td align="right" style="padding:6px 0;font-size:12px;color:${C.subtle};">${right}</td></tr></table>`;
}

function eventTable(events: AlertEvent[]): string {
  const rows = events
    .map((e) => {
      const offline = e.type === "OFFLINE";
      const names = e.affectedCameraNames?.length
        ? `<div style="font-size:12px;color:${C.subtle};padding-top:2px;">${escapeHtml(e.affectedCameraNames.slice(0, 8).join(", "))}${(e.affectedCameras ?? 0) > 8 ? ` +${(e.affectedCameras ?? 0) - Math.min(8, e.affectedCameraNames.length)} more` : ""}</div>`
        : "";
      const still = e.stillOfflineCameraNames?.length
        ? `<div style="font-size:12px;color:${C.danger};padding-top:2px;">Still offline: ${escapeHtml(e.stillOfflineCameraNames.slice(0, 8).join(", "))}${(e.stillOfflineCameras ?? 0) > 8 ? ` +${(e.stillOfflineCameras ?? 0) - Math.min(8, e.stillOfflineCameraNames.length)} more` : ""}</div>`
        : "";
      const when = offline
        ? `${escapeHtml(formatInZone(e.startedAt, tz()))}`
        : `${escapeHtml(formatInZone(e.startedAt, tz()))}<br><span style="color:${C.subtle};">to ${escapeHtml(e.endedAt ? formatInZone(e.endedAt, tz()) : "-")}</span>`;
      return `<tr>
<td ${TD}>${pill(offline ? "Offline" : "Restored", offline ? "danger" : "success")}</td>
<td ${TD}><div style="font-weight:600;">${escapeHtml(entityTitle(e))}</div><div style="font-size:12px;color:${C.subtle};padding-top:2px;">${escapeHtml(entitySub(e))}</div>${names}${still}</td>
<td ${TD}>${when}</td>
<td ${TD}><span style="font-weight:600;">${escapeHtml(formatDowntime(e.downtimeSeconds))}</span></td>
<td ${TD_MUTED}>${escapeHtml(e.detail ?? (offline ? "No response" : "Back online"))}</td>
</tr>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
<tr><th ${TH}>Status</th><th ${TH}>Device</th><th ${TH}>Offline since</th><th ${TH}>Downtime</th><th ${TH}>Detail</th></tr>${rows}</table>`;
}

function textEvent(e: AlertEvent): string {
  const lines = [`  - ${entityTitle(e)}: ${e.type === "OFFLINE" ? "OFFLINE" : "RESTORED"}`, `    ${entitySub(e)}`];
  if (e.affectedCameraNames?.length) lines.push(`    Cameras: ${e.affectedCameraNames.slice(0, 8).join(", ")}${(e.affectedCameras ?? 0) > 8 ? " ..." : ""}`);
  if (e.stillOfflineCameraNames?.length) lines.push(`    Still offline: ${e.stillOfflineCameraNames.slice(0, 8).join(", ")}${(e.stillOfflineCameras ?? 0) > 8 ? " ..." : ""}`);
  lines.push(`    Offline since: ${formatInZone(e.startedAt, tz())}`);
  if (e.type === "RESTORED" && e.endedAt) lines.push(`    Back online: ${formatInZone(e.endedAt, tz())}`);
  lines.push(`    ${e.type === "OFFLINE" ? "Downtime so far" : "Total downtime"}: ${formatDowntime(e.downtimeSeconds)}`);
  if (e.detail) lines.push(`    Detail: ${e.detail}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Offline / restored alert
// ---------------------------------------------------------------------------
export function renderAlertEmail(events: AlertEvent[], now: Date = new Date()): { subject: string; text: string; html: string; kind: "OFFLINE" | "ONLINE" } {
  const offline = events.filter((e) => e.type === "OFFLINE");
  const restored = events.filter((e) => e.type === "RESTORED");
  const kind = offline.length > 0 ? "OFFLINE" : "ONLINE";

  const subject =
    offline.length > 0
      ? `[${BRAND}] OFFLINE: ${describe(offline)}${where(offline)}${restored.length ? ` (+${restored.length} restored)` : ""}`
      : `[${BRAND}] RESTORED: ${describe(restored)}${where(restored)}`;

  const title = offline.length > 0 ? `${describe(offline)} offline${where(offline)}` : `${describe(restored)} back online${where(restored)}`;
  const subtitle = `Detected ${formatInZone(now, tz())}${offline.length && restored.length ? ` · ${plural(restored.length, "item")} also restored` : ""}`;

  const section = (label: string, list: AlertEvent[]) => {
    if (!list.length) return "";
    const groups = groupByLocation(list);
    return `<div style="padding-top:12px;font-size:12px;font-weight:700;color:${C.subtle};text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(label)}</div>${groups
      .map((g) => locationHeading(g.location) + eventTable(g.items))
      .join("")}`;
  };

  const html = layout({
    preheader: subject.replace(`[${BRAND}] `, ""),
    title,
    subtitle,
    accent: offline.length ? C.danger : C.success,
    body: section("Went offline", offline) + section("Back online", restored),
    cta: { label: "Open camera health", href: appUrl("/health") },
  });

  const textSection = (label: string, list: AlertEvent[]) => {
    if (!list.length) return [];
    const out = [`${label.toUpperCase()} (${list.length})`];
    for (const g of groupByLocation(list)) {
      out.push("", `Location: ${locationLine(g.location)}`);
      for (const e of g.items) out.push(textEvent(e));
    }
    return out;
  };
  const text = [
    `${BRAND} - ${title}`,
    subtitle,
    "",
    ...textSection("Went offline", offline),
    ...(offline.length && restored.length ? [""] : []),
    ...textSection("Back online", restored),
    "",
    `Open camera health: ${appUrl("/health")}`,
    `Times are shown in ${tz()}. This is an automated message.`,
  ].join("\n");

  return { subject, text, html, kind };
}

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------
export interface ReportIncidentRow {
  entityType: "CAMERA" | "DEVICE";
  name: string;
  recorderName: string | null;
  channel: number | null;
  startedAt: Date;
  endedAt: Date | null;
  /** Downtime inside the report day. */
  daySeconds: number;
  /** Whole incident so far. */
  totalSeconds: number;
  stillOffline: boolean;
  detail: string | null;
  /** DEVICE only: camera incidents caused by this recorder outage. */
  affectedCameras?: number;
  affectedCameraNames?: string[];
}

export interface ReportLocation {
  location: AlertLocation;
  monitoredCameras: number;
  monitoredRecorders: number;
  /** Camera availability over the day (0-100), null when nothing is monitored. */
  availabilityPct: number | null;
  downtimeSeconds: number;
  incidents: ReportIncidentRow[];
}

export interface ReportOfflineRow {
  location: AlertLocation;
  entityType: "CAMERA" | "DEVICE";
  name: string;
  recorderName: string | null;
  channel: number | null;
  since: Date | null;
  downtimeSeconds: number | null;
  detail: string | null;
  affectedCameras?: number;
}

export interface ReportData {
  day: DayRange;
  generatedAt: Date;
  scopeLabel: string;
  summary: { incidents: number; camerasAffected: number; devicesAffected: number; stillOffline: number; totalDowntimeSeconds: number };
  locations: ReportLocation[];
  currentlyOffline: ReportOfflineRow[];
  notMonitored: { recorders: number; pendingNetwork: number; cloudOnly: number; disabled: number; other: number };
}

function reportEntity(r: { entityType: "CAMERA" | "DEVICE"; name: string; channel: number | null; recorderName: string | null; affectedCameras?: number }): { title: string; sub: string } {
  if (r.entityType === "DEVICE") return { title: `Recorder ${r.name}`, sub: r.affectedCameras ? `${plural(r.affectedCameras, "camera")} affected` : "Recorder" };
  return { title: `${r.name}${r.channel ? ` (channel ${r.channel})` : ""}`, sub: r.recorderName ? `On ${r.recorderName}` : "Standalone camera" };
}

function pctTone(p: number | null): "success" | "warning" | "danger" | "neutral" {
  if (p == null) return "neutral";
  if (p >= 99) return "success";
  if (p >= 95) return "warning";
  return "danger";
}

export function renderDailyReportEmail(data: ReportData): { subject: string; text: string; html: string } {
  const s = data.summary;
  const healthy = s.incidents === 0 && data.currentlyOffline.length === 0;
  const subject = `[${BRAND}] Daily health report - ${data.day.label}: ${
    healthy ? "no downtime" : `${plural(s.incidents, "incident")}, ${plural(data.currentlyOffline.length, "item")} offline now`
  }`;
  const z = tz();

  const tile = (label: string, value: string, color: string = C.ink) =>
    `<td width="25%" style="padding:10px 12px;border:1px solid ${C.border};border-radius:4px;background:${C.surface};"><div style="font-size:11px;color:${C.subtle};text-transform:uppercase;letter-spacing:0.4px;font-weight:700;">${escapeHtml(label)}</div><div style="font-size:20px;font-weight:700;color:${color};padding-top:4px;">${escapeHtml(value)}</div></td>`;
  const tiles = `<table role="presentation" width="100%" cellpadding="0" cellspacing="6" border="0" style="border-collapse:separate;margin-top:4px;"><tr>
${tile("Incidents", String(s.incidents), s.incidents ? C.danger : C.success)}
${tile("Cameras affected", String(s.camerasAffected))}
${tile("Recorders affected", String(s.devicesAffected))}
${tile("Offline now", String(data.currentlyOffline.length), data.currentlyOffline.length ? C.danger : C.success)}
</tr></table>`;

  const sectionLabel = (t: string) => `<div style="padding-top:18px;font-size:12px;font-weight:700;color:${C.subtle};text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(t)}</div>`;

  // Availability by location
  const availRows = data.locations
    .map(
      (l) => `<tr>
<td ${TD}><div style="font-weight:600;">${escapeHtml(l.location.name)}</div><div style="font-size:12px;color:${C.subtle};">${escapeHtml(siteKindLabel(l.location.kind))}${l.location.code ? ` &middot; ${escapeHtml(l.location.code)}` : ""}</div></td>
<td ${TD}>${l.monitoredRecorders} / ${l.monitoredCameras}</td>
<td ${TD}>${l.incidents.length}</td>
<td ${TD}>${escapeHtml(formatDowntime(l.downtimeSeconds))}</td>
<td ${TD}>${pill(l.availabilityPct == null ? "n/a" : `${l.availabilityPct.toFixed(1)}%`, pctTone(l.availabilityPct))}</td>
</tr>`,
    )
    .join("");
  const availTable = data.locations.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><th ${TH}>Location</th><th ${TH}>Recorders / cameras</th><th ${TH}>Incidents</th><th ${TH}>Downtime</th><th ${TH}>Availability</th></tr>${availRows}</table>`
    : `<div style="font-size:13px;color:${C.subtle};padding:8px 0;">No monitored locations in this report.</div>`;

  // Incident log per location
  const incidentBlocks = data.locations
    .filter((l) => l.incidents.length)
    .map((l) => {
      const rows = l.incidents
        .map((r) => {
          const ent = reportEntity(r);
          const names = r.affectedCameraNames?.length ? `<div style="font-size:12px;color:${C.subtle};padding-top:2px;">${escapeHtml(r.affectedCameraNames.slice(0, 6).join(", "))}${(r.affectedCameras ?? 0) > 6 ? " ..." : ""}</div>` : "";
          return `<tr>
<td ${TD}><div style="font-weight:600;">${escapeHtml(ent.title)}</div><div style="font-size:12px;color:${C.subtle};">${escapeHtml(ent.sub)}</div>${names}</td>
<td ${TD}>${escapeHtml(formatInZone(r.startedAt, z))}</td>
<td ${TD}>${r.endedAt ? escapeHtml(formatInZone(r.endedAt, z)) : pill("Still offline", "danger")}</td>
<td ${TD}><span style="font-weight:600;">${escapeHtml(formatDowntime(r.daySeconds))}</span>${r.totalSeconds > r.daySeconds + 59 ? `<div style="font-size:12px;color:${C.subtle};">${escapeHtml(formatDowntime(r.totalSeconds))} total</div>` : ""}</td>
<td ${TD_MUTED}>${escapeHtml(r.detail ?? "")}</td>
</tr>`;
        })
        .join("");
      return (
        locationHeading(l.location, `${plural(l.incidents.length, "incident")} &middot; ${escapeHtml(formatDowntime(l.downtimeSeconds))}`) +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><th ${TH}>Device</th><th ${TH}>Went offline</th><th ${TH}>Back online</th><th ${TH}>Downtime (day)</th><th ${TH}>Detail</th></tr>${rows}</table>`
      );
    })
    .join("");

  // Currently offline
  const offRows = data.currentlyOffline
    .map((r) => {
      const ent = reportEntity(r);
      return `<tr>
<td ${TD}><div style="font-weight:600;">${escapeHtml(ent.title)}</div><div style="font-size:12px;color:${C.subtle};">${escapeHtml(ent.sub)}</div></td>
<td ${TD}>${escapeHtml(r.location.name)}</td>
<td ${TD}>${r.since ? escapeHtml(formatInZone(r.since, z)) : "-"}</td>
<td ${TD}><span style="font-weight:600;">${escapeHtml(formatDowntime(r.downtimeSeconds))}</span></td>
<td ${TD_MUTED}>${escapeHtml(r.detail ?? "")}</td>
</tr>`;
    })
    .join("");
  const offTable = data.currentlyOffline.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><th ${TH}>Device</th><th ${TH}>Location</th><th ${TH}>Offline since</th><th ${TH}>Downtime</th><th ${TH}>Detail</th></tr>${offRows}</table>`
    : `<div style="font-size:13px;color:${C.success};padding:8px 0;font-weight:600;">Every monitored camera and recorder is online right now.</div>`;

  const nm = data.notMonitored;
  const notMonitoredNote =
    nm.recorders > 0
      ? `<div style="margin-top:18px;padding:10px 12px;background:${C.warningBg};border-left:3px solid ${C.warning};font-size:12px;line-height:18px;color:${C.ink};">${escapeHtml(
          `${plural(nm.recorders, "recorder")} not monitored and excluded from this report: ${[
            nm.pendingNetwork ? `${nm.pendingNetwork} pending network route` : "",
            nm.cloudOnly ? `${nm.cloudOnly} cloud-only (no API)` : "",
            nm.disabled ? `${nm.disabled} disabled` : "",
            nm.other ? `${nm.other} without an address` : "",
          ]
            .filter(Boolean)
            .join(", ")}.`,
        )}</div>`
      : "";

  const html = layout({
    preheader: subject.replace(`[${BRAND}] `, ""),
    title: `Daily health report · ${data.day.label}`,
    subtitle: `${data.scopeLabel} · 00:00-24:00 ${z} · generated ${formatInZone(data.generatedAt, z)}`,
    accent: healthy ? C.success : C.danger,
    body:
      tiles +
      sectionLabel("Availability by location") +
      availTable +
      sectionLabel("Offline right now") +
      offTable +
      (incidentBlocks ? sectionLabel("Downtime log") + incidentBlocks : sectionLabel("Downtime log") + `<div style="font-size:13px;color:${C.subtle};padding:8px 0;">No camera or recorder went offline on ${escapeHtml(data.day.label)}.</div>`) +
      notMonitoredNote,
    cta: { label: "Open downtime reports", href: appUrl("/reports") },
  });

  const t: string[] = [
    `${BRAND} - Daily health report for ${data.day.label} (${data.scopeLabel})`,
    `Window: 00:00-24:00 ${z}. Generated ${formatInZone(data.generatedAt, z)}.`,
    "",
    `Incidents: ${s.incidents} | Cameras affected: ${s.camerasAffected} | Recorders affected: ${s.devicesAffected} | Offline now: ${data.currentlyOffline.length} | Downtime: ${formatDowntime(s.totalDowntimeSeconds)}`,
    "",
    "AVAILABILITY BY LOCATION",
  ];
  if (!data.locations.length) t.push("  No monitored locations in this report.");
  for (const l of data.locations) {
    t.push(`  - ${locationLine(l.location)}: ${l.availabilityPct == null ? "n/a" : `${l.availabilityPct.toFixed(1)}%`}, ${plural(l.incidents.length, "incident")}, downtime ${formatDowntime(l.downtimeSeconds)}`);
  }
  t.push("", "OFFLINE RIGHT NOW");
  if (!data.currentlyOffline.length) t.push("  Every monitored camera and recorder is online.");
  for (const r of data.currentlyOffline) {
    const ent = reportEntity(r);
    t.push(`  - ${ent.title} at ${r.location.name} (${ent.sub}): offline since ${r.since ? formatInZone(r.since, z) : "-"}, ${formatDowntime(r.downtimeSeconds)}${r.detail ? ` - ${r.detail}` : ""}`);
  }
  t.push("", "DOWNTIME LOG");
  const withIncidents = data.locations.filter((l) => l.incidents.length);
  if (!withIncidents.length) t.push(`  No camera or recorder went offline on ${data.day.label}.`);
  for (const l of withIncidents) {
    t.push(`  ${locationLine(l.location)}`);
    for (const r of l.incidents) {
      const ent = reportEntity(r);
      t.push(
        `    - ${ent.title} (${ent.sub}): ${formatInZone(r.startedAt, z)} -> ${r.endedAt ? formatInZone(r.endedAt, z) : "STILL OFFLINE"}, ${formatDowntime(r.daySeconds)} that day${r.totalSeconds > r.daySeconds + 59 ? ` (${formatDowntime(r.totalSeconds)} total)` : ""}${r.detail ? ` - ${r.detail}` : ""}`,
      );
    }
  }
  if (nm.recorders > 0) t.push("", `${plural(nm.recorders, "recorder")} not monitored (pending network ${nm.pendingNetwork}, cloud-only ${nm.cloudOnly}, disabled ${nm.disabled}, no address ${nm.other}).`);
  t.push("", `Open downtime reports: ${appUrl("/reports")}`);

  return { subject, text: t.join("\n"), html };
}

// ---------------------------------------------------------------------------
// Test email
// ---------------------------------------------------------------------------
export function renderTestEmail(now: Date = new Date()): { subject: string; text: string; html: string } {
  const when = formatInZone(now, tz());
  const subject = `[${BRAND}] Test email`;
  const text = `${BRAND} test email\n\nSent ${when}. If you received this, alert emails from the monitoring system can reach this mailbox.\n\n${appUrl("/alerts")}`;
  const html = layout({
    preheader: "Alert email delivery works",
    title: "Test email",
    subtitle: `Sent ${when}`,
    accent: C.header,
    body: `<p style="font-size:14px;line-height:21px;color:${C.ink};margin:8px 0;">If you received this, offline/online alerts and daily health reports from the monitoring system can reach this mailbox.</p>`,
    cta: { label: "Open alert settings", href: appUrl("/alerts") },
  });
  return { subject, text, html };
}
