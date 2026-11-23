import { protocolFamilyOf } from "./index";

/**
 * RTSP path builders per protocol family. Pure string functions, no secrets:
 * credentials and host are added by lib/rtsp buildRtspUrl on the server only.
 */

/** What a path builder needs to know about a recorder. Matches the `devices` row shape. */
export interface PathDevice {
  vendor: string;
  notes?: string | null;
}

/** Hikvision/Tyco live path: channel 3 main = /Streaming/Unicast/channels/301, sub = .../302. */
export function hikvisionLivePath(channel: number, subStream = false): string {
  return `/Streaming/Unicast/channels/${channel}${subStream ? "02" : "01"}`;
}

/** Dahua/CP Plus live path: subtype 0 = main stream, 1 = sub stream. Channels are 1-based. */
export function dahuaLivePath(channel: number, subStream = false): string {
  return `/cam/realmonitor?channel=${channel}&subtype=${subStream ? 1 : 0}`;
}

/** Recorder wall-clock instant (already shifted to the recorder's clock, read via UTC getters) as YYYY_MM_DD_HH_mm_ss. */
export function formatDahuaTime(wallClock: Date): string {
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${wallClock.getUTCFullYear()}_${p(wallClock.getUTCMonth() + 1)}_${p(wallClock.getUTCDate())}_${p(wallClock.getUTCHours())}_${p(wallClock.getUTCMinutes())}_${p(wallClock.getUTCSeconds())}`;
}

/** Dahua/CP Plus playback path. `start`/`end` are recorder wall-clock strings from formatDahuaTime. */
export function dahuaPlaybackPath(channel: number, start: string, end: string): string {
  return `/cam/playback?channel=${channel}&starttime=${start}&endtime=${end}`;
}

/** Template placeholders: {channel}, {stream} (0 main / 1 sub), {streamNo} (1 main / 2 sub), {track} (Hikvision-style 101/102). */
export const RTSP_TEMPLATE_PLACEHOLDERS = ["{channel}", "{stream}", "{streamNo}", "{track}"] as const;

export function applyRtspTemplate(template: string, channel: number, subStream = false): string {
  const path = template
    .replace(/\{channel\}/g, String(channel))
    .replace(/\{streamNo\}/g, subStream ? "2" : "1")
    .replace(/\{stream\}/g, subStream ? "1" : "0")
    .replace(/\{track\}/g, `${channel}${subStream ? "02" : "01"}`);
  return path.startsWith("/") ? path : `/${path}`;
}

/** Returns an error message, or null when the template is usable. */
export function validateRtspTemplate(template: string): string | null {
  const t = template.trim();
  if (!t) return null;
  if (t.length > 300) return "Template is too long (300 characters max)";
  if (!t.startsWith("/")) return "Template must start with /";
  if (/\s/.test(t)) return "Template must not contain spaces";
  // The template is a path only: host and credentials always come from the recorder.
  if (t.includes("://") || t.includes("@")) return "Template is a path only: do not include rtsp://, a host or credentials";
  if (!t.includes("{channel}")) return "Template must contain {channel}";
  const unknown = (t.match(/\{[^}]*\}/g) ?? []).filter((p) => !(RTSP_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(p));
  if (unknown.length) return `Unknown placeholder ${unknown[0]}. Use ${RTSP_TEMPLATE_PLACEHOLDERS.join(", ")}`;
  return null;
}

/**
 * The devices table has no template column, so the template is kept as one
 * marker line inside the recorder notes ("RTSP template: /path/{channel}").
 */
export const RTSP_TEMPLATE_MARKER = "RTSP template:";

const markerLine = /^\s*RTSP template:\s*(\S*)\s*$/im;

export function rtspTemplateFromNotes(notes: string | null | undefined): string | null {
  const m = markerLine.exec(notes ?? "");
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** Notes without the template marker line (what the form shows in the Notes box). */
export function stripRtspTemplate(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const out = notes
    .split(/\r?\n/)
    .filter((l) => !markerLine.test(l))
    .join("\n")
    .trim();
  return out ? out : null;
}

/** Notes with the template marker set (or removed when `template` is empty). */
export function withRtspTemplate(notes: string | null | undefined, template: string | null | undefined): string | null {
  const base = stripRtspTemplate(notes);
  const t = (template ?? "").trim();
  if (!t) return base;
  return base ? `${base}\n${RTSP_TEMPLATE_MARKER} ${t}` : `${RTSP_TEMPLATE_MARKER} ${t}`;
}

/** True when the recorder has enough information to derive a channel path without the legacy Hikvision fallback. */
export function canBuildChannelPath(device: PathDevice | null | undefined): boolean {
  if (!device) return false;
  const family = protocolFamilyOf(device.vendor);
  return family !== "template" || rtspTemplateFromNotes(device.notes) !== null;
}

/**
 * RTSP path (with query) of a recorder channel's live stream.
 *  isapi    -> /Streaming/Unicast/channels/<ch>01|02 (unchanged from the original Hikvision behaviour)
 *  dahua    -> /cam/realmonitor?channel=<ch>&subtype=0|1
 *  template -> the device's template; without one, the legacy Hikvision path (what every recorder got before)
 */
export function buildLiveRtspUrlPath(device: PathDevice | null | undefined, channel: number, subStream = false): string {
  const family = device ? protocolFamilyOf(device.vendor) : "isapi";
  if (family === "dahua") return dahuaLivePath(channel, subStream);
  if (family === "template") {
    const template = rtspTemplateFromNotes(device?.notes);
    if (template) return applyRtspTemplate(template, channel, subStream);
  }
  return hikvisionLivePath(channel, subStream);
}

/** True when `path` is exactly what older code auto-generated for `channel` (Hikvision main or sub stream). */
export function isAutoHikvisionPath(path: string, channel: number): boolean {
  return path === hikvisionLivePath(channel, false) || path === hikvisionLivePath(channel, true);
}

/** Channel number from a stored path: Hikvision channels/101, tracks/101, or Dahua ?channel=N. */
export function channelFromRtspPath(rtspPath: string): number | null {
  const m = /channels\/(\d+?)(0[12])$/i.exec(rtspPath) ?? /tracks\/(\d+?)(0[12])$/i.exec(rtspPath) ?? /[?&]channel=(\d+)/i.exec(rtspPath);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}
