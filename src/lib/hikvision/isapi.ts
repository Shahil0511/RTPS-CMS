import "server-only";
import { randomUUID } from "node:crypto";
import type { Device } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { DigestAuthError, digestFetch } from "./digest";

/**
 * Hikvision ISAPI client for NVR/DVR recorders: device facts, disk health,
 * clock, recording search and file download. Nothing is cached on disk.
 */

// ---------------------------------------------------------------------------
// XML helpers (namespace-agnostic, enough for ISAPI's flat documents)
// ---------------------------------------------------------------------------
function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ?? "");
  return out;
}

function tag(xml: string, name: string): string | null {
  const v = blocks(xml, name)[0];
  return v === undefined ? null : decodeXml(v.trim());
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export class IsapiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function baseUrl(device: Device): string {
  const scheme = device.httpsEnabled ? "https" : "http";
  const defaultPort = device.httpsEnabled ? 443 : 80;
  return `${scheme}://${device.host}${device.httpPort === defaultPort ? "" : `:${device.httpPort}`}`;
}

function credentials(device: Device): { user: string; pass: string } {
  return { user: device.username ?? "admin", pass: device.passwordEnc ? decryptSecret(device.passwordEnc) : "" };
}

/**
 * Hikvision locks an account after a handful of failed logins. After any
 * rejection we stop calling that recorder for AUTH_BACKOFF_MS, keyed by the
 * stored credentials so saving a new password retries immediately.
 */
const AUTH_BACKOFF_MS = 30 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __vmsIsapiAuthBackoff: Map<string, { key: string; until: number }> | undefined;
}
const authBackoff = globalThis.__vmsIsapiAuthBackoff ?? (globalThis.__vmsIsapiAuthBackoff = new Map());

const credentialKey = (device: Device) => `${device.host}:${device.httpPort}|${device.username ?? ""}|${device.passwordEnc ?? ""}`;

export function authBlockedUntil(device: Device): Date | null {
  const b = authBackoff.get(device.id);
  if (!b || b.key !== credentialKey(device) || b.until < Date.now()) return null;
  return new Date(b.until);
}

declare global {
  // eslint-disable-next-line no-var
  var __vmsIsapiQueues: Map<string, Promise<unknown>> | undefined;
}
const queues = globalThis.__vmsIsapiQueues ?? (globalThis.__vmsIsapiQueues = new Map());

/** Runs ISAPI calls to one recorder one after another, so a bad password costs a single attempt, not a burst. */
function serialize<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(deviceId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(task);
  const tail = next.catch(() => undefined);
  queues.set(deviceId, tail);
  void tail.then(() => {
    if (queues.get(deviceId) === tail) queues.delete(deviceId);
  });
  return next;
}

function assertNotBlocked(device: Device): void {
  const blocked = authBlockedUntil(device);
  if (blocked) {
    throw new IsapiError(`Recorder login was rejected; retrying after ${blocked.toLocaleTimeString()} to avoid locking the account. Fix the password on the Recorders page to retry now.`, 401);
  }
}

async function authorizedFetch(device: Device, url: string, req: Parameters<typeof digestFetch>[3]): Promise<Response> {
  assertNotBlocked(device);
  return serialize(device.id, async () => {
    // Re-check: an earlier queued call may have just been rejected.
    assertNotBlocked(device);
    const { user, pass } = credentials(device);
    try {
      return await digestFetch(url, user, pass, req);
    } catch (e) {
      if (e instanceof DigestAuthError) authBackoff.set(device.id, { key: credentialKey(device), until: Date.now() + AUTH_BACKOFF_MS });
      throw e;
    }
  });
}

async function request(device: Device, path: string, init: { method?: "GET" | "POST" | "PUT"; body?: string; timeoutMs?: number } = {}): Promise<string> {
  const res = await authorizedFetch(device, `${baseUrl(device)}${path}`, {
    method: init.method,
    body: init.body,
    headers: init.body ? { "Content-Type": "application/xml; charset=UTF-8" } : undefined,
    timeoutMs: init.timeoutMs,
  });
  const text = await res.text();
  if (!res.ok) {
    const status = tag(text, "statusString") ?? tag(text, "subStatusCode") ?? res.statusText;
    throw new IsapiError(`ISAPI ${path} failed: HTTP ${res.status} ${status ?? ""}`.trim(), res.status);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Device facts
// ---------------------------------------------------------------------------
export interface IsapiDeviceInfo {
  deviceName: string | null;
  model: string | null;
  serialNumber: string | null;
  firmware: string | null;
  deviceType: string | null;
}

export async function getDeviceInfo(device: Device): Promise<IsapiDeviceInfo> {
  const xml = await request(device, "/ISAPI/System/deviceInfo");
  const firmware = [tag(xml, "firmwareVersion"), tag(xml, "firmwareReleasedDate")].filter(Boolean).join(" ");
  return {
    deviceName: tag(xml, "deviceName"),
    model: tag(xml, "model"),
    serialNumber: tag(xml, "serialNumber"),
    firmware: firmware || null,
    deviceType: tag(xml, "deviceType"),
  };
}

export interface IsapiStorage {
  disks: Array<{ id: string; name: string | null; status: string; capacityMb: number | null; freeMb: number | null }>;
  totalMb: number | null;
  freeMb: number | null;
  summary: string;
  healthy: boolean;
}

/** Reads the recorder's HDD list (status, capacity, free space). */
export async function getStorage(device: Device): Promise<IsapiStorage> {
  const xml = await request(device, "/ISAPI/ContentMgmt/Storage");
  const disks = blocks(xml, "hdd").map((h) => ({
    id: tag(h, "id") ?? "?",
    name: tag(h, "hddName"),
    status: (tag(h, "status") ?? "unknown").toLowerCase(),
    capacityMb: numberOrNull(tag(h, "capacity")),
    freeMb: numberOrNull(tag(h, "freeSpace")),
  }));
  const totalMb = disks.reduce<number | null>((acc, d) => (d.capacityMb == null ? acc : (acc ?? 0) + d.capacityMb), null);
  const freeMb = disks.reduce<number | null>((acc, d) => (d.freeMb == null ? acc : (acc ?? 0) + d.freeMb), null);
  // "idle"/"standby" are spun-down disks; free space 0 is normal for loop recording.
  const bad = disks.filter((d) => !["ok", "idle", "standby", "sleeping"].includes(d.status));
  const healthy = disks.length > 0 && bad.length === 0;
  const summary =
    disks.length === 0
      ? "No HDD reported"
      : healthy
        ? `${disks.length} HDD OK`
        : bad.map((d) => `HDD ${d.id}: ${d.status}`).join(", ");
  return { disks, totalMb, freeMb, summary, healthy };
}

export interface IsapiClock {
  /** UTC offset reported by the recorder, in minutes (e.g. "+05:30" -> 330). */
  offsetMinutes: number | null;
  /** Recorder clock minus real time, in seconds (positive = recorder is fast). */
  driftSeconds: number | null;
  ntp: boolean;
}

/** Reads the recorder clock and measures how far it is from this server's clock. */
export async function getClock(device: Device): Promise<IsapiClock> {
  const sentAt = Date.now();
  const xml = await request(device, "/ISAPI/System/time");
  const receivedAt = Date.now();
  const local = tag(xml, "localTime");
  const m = local ? /([+-])(\d{2}):?(\d{2})$/.exec(local) : null;
  const offsetMinutes = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : local && /Z$/i.test(local) ? 0 : null;
  const reported = local ? Date.parse(local) : Number.NaN;
  const midpoint = (sentAt + receivedAt) / 2;
  const driftSeconds = Number.isFinite(reported) ? Math.round((reported - midpoint) / 1000) : null;
  return { offsetMinutes, driftSeconds, ntp: (tag(xml, "timeMode") ?? "").toUpperCase() === "NTP" };
}

export interface IsapiChannel {
  id: number;
  name: string;
  ipAddress: string | null;
}

/** IP channels configured on the recorder (id = channel number, name as set on the NVR). */
export async function getChannels(device: Device): Promise<IsapiChannel[]> {
  const xml = await request(device, "/ISAPI/ContentMgmt/InputProxy/channels", { timeoutMs: 20_000 });
  return blocks(xml, "InputProxyChannel")
    .map((b) => ({ id: Number(tag(b, "id")), name: (tag(b, "name") ?? "").trim(), ipAddress: tag(b, "ipAddress") }))
    .filter((c) => Number.isInteger(c.id) && c.id > 0)
    .map((c) => ({ ...c, name: c.name || `Channel ${c.id}` }));
}

export interface ChannelStatus {
  online: boolean;
  /** Recorder's reason, e.g. "connect", "netUnreachable", "passwordError". */
  detail: string | null;
  ipAddress: string | null;
}

/** Per-channel online state as seen by the recorder: no video needs to be pulled to know it. */
export async function getChannelStatus(device: Device): Promise<Map<number, ChannelStatus>> {
  const xml = await request(device, "/ISAPI/ContentMgmt/InputProxy/channels/status", { timeoutMs: 15_000 });
  const out = new Map<number, ChannelStatus>();
  for (const b of blocks(xml, "InputProxyChannelStatus")) {
    const id = Number(tag(b, "id"));
    if (!Number.isInteger(id)) continue;
    out.set(id, { online: (tag(b, "online") ?? "").toLowerCase() === "true", detail: tag(b, "chanDetectResult"), ipAddress: tag(b, "ipAddress") });
  }
  return out;
}

/** Number of IP/analog channels the recorder exposes. */
export async function getChannelCount(device: Device): Promise<number | null> {
  for (const [path, item] of [
    ["/ISAPI/ContentMgmt/InputProxy/channels", "InputProxyChannel"],
    ["/ISAPI/System/Video/inputs/channels", "VideoInputChannel"],
  ] as const) {
    try {
      const xml = await request(device, path);
      const n = blocks(xml, item).length;
      if (n > 0) return n;
    } catch {
      // try the next endpoint
    }
  }
  return null;
}

function numberOrNull(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Time conversion. Recorders exchange times as "YYYY-MM-DDTHH:MM:SSZ" (search)
// and "YYYYMMDDTHHMMSSZ" (RTSP). With timeMode "local" the digits are the
// recorder's wall clock despite the Z; with "utc" they are real UTC.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line no-var
  var __vmsDetectedOffsets: Map<string, number> | undefined;
}
const detectedOffsets = globalThis.__vmsDetectedOffsets ?? (globalThis.__vmsDetectedOffsets = new Map<string, number>());

/** True when this process has measured the recorder's UTC offset (lost on restart). */
export function hasDetectedOffset(deviceId: string): boolean {
  return detectedOffsets.has(deviceId);
}

export function rememberDetectedOffset(deviceId: string, minutes: number | null): void {
  if (minutes == null) detectedOffsets.delete(deviceId);
  else detectedOffsets.set(deviceId, minutes);
}

/** Offset of a timezone (IANA name) at a given instant, in minutes. */
export function tzOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  } catch {
    return 0;
  }
}

export interface DeviceClock {
  mode: "local" | "utc";
  offsetMinutes: number;
  /** Recorder clock error in seconds (positive = fast). Footage is indexed by the recorder's own clock. */
  driftSeconds: number;
}

export function deviceClock(device: Device, siteTimeZone: string): DeviceClock {
  const mode = device.timeMode === "utc" ? "utc" : "local";
  const offsetMinutes = device.utcOffsetMinutes ?? detectedOffsets.get(device.id) ?? tzOffsetMinutes(siteTimeZone);
  return { mode, offsetMinutes, driftSeconds: device.clockDriftSeconds ?? 0 };
}

/** Real instant -> recorder wall clock (direction 1) and back (direction -1), including drift. */
function shift(date: Date, clock: DeviceClock, direction: 1 | -1): Date {
  const zone = clock.mode === "local" ? clock.offsetMinutes * 60_000 : 0;
  return new Date(date.getTime() + direction * (zone + clock.driftSeconds * 1000));
}

const pad = (n: number) => n.toString().padStart(2, "0");

/** Real instant -> recorder "Z" string. */
export function toDeviceTime(date: Date, clock: DeviceClock, style: "dashed" | "compact"): string {
  const d = shift(date, clock, 1);
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  return style === "dashed" ? `${y}-${mo}-${da}T${h}:${mi}:${s}Z` : `${y}${mo}${da}T${h}${mi}${s}Z`;
}

/** Recorder time string (dashed, compact or "YYYY-MM-DD HH:MM:SSZ") -> real instant. */
export function fromDeviceTime(value: string, clock: DeviceClock): Date | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})[T ](\d{2}):?(\d{2}):?(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(value.trim());
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const zone = m[7];
  if (zone && zone.toUpperCase() !== "Z") {
    // An explicit numeric offset is unambiguous.
    const z = /([+-])(\d{2}):?(\d{2})/.exec(zone);
    const off = z ? (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) : 0;
    return new Date(wall - off * 60_000);
  }
  return shift(new Date(wall), clock, -1);
}

// ---------------------------------------------------------------------------
// Recording search
// ---------------------------------------------------------------------------
export interface RecordingSegment {
  start: Date;
  end: Date;
  playbackUri: string | null;
}

const PAGE_SIZE = 40;
const MAX_PAGES = 50;

/**
 * Lists recorded segments of a track (channel*100+1) overlapping [from, to].
 * Pages through "MORE" results; segments are clamped to the window and sorted.
 */
export async function searchRecordings(device: Device, trackId: number, from: Date, to: Date, clock: DeviceClock): Promise<RecordingSegment[]> {
  const searchId = randomUUID().toUpperCase();
  const out: RecordingSegment[] = [];
  let position = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<CMSearchDescription version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">` +
      `<searchID>${searchId}</searchID>` +
      `<trackIDList><trackID>${trackId}</trackID></trackIDList>` +
      `<timeSpanList><timeSpan><startTime>${toDeviceTime(from, clock, "dashed")}</startTime><endTime>${toDeviceTime(to, clock, "dashed")}</endTime></timeSpan></timeSpanList>` +
      `<maxResults>${PAGE_SIZE}</maxResults>` +
      `<searchResultPostion>${position}</searchResultPostion>` +
      `<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>` +
      `</CMSearchDescription>`;

    const xml = await request(device, "/ISAPI/ContentMgmt/search", { method: "POST", body, timeoutMs: 20_000 });
    const status = (tag(xml, "responseStatusStrg") ?? "").toUpperCase();
    if (status === "NO MATCHES") break;
    if (status.includes("INVALID")) throw new IsapiError(`Recorder rejected the search (${status})`, 400);

    const items = blocks(xml, "searchMatchItem");
    for (const item of items) {
      const span = blocks(item, "timeSpan")[0] ?? item;
      const s = tag(span, "startTime");
      const e = tag(span, "endTime");
      const start = s ? fromDeviceTime(s, clock) : null;
      const end = e ? fromDeviceTime(e, clock) : null;
      if (!start || !end || end <= start) continue;
      out.push({
        start: start < from ? from : start,
        end: end > to ? to : end,
        playbackUri: tag(item, "playbackURI"),
      });
    }
    position += items.length;
    if (status !== "MORE" || items.length === 0) break;
  }

  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out.filter((s) => s.end > s.start);
}

/** Merges touching/overlapping segments (gap below `gapMs`) into continuous blocks. */
export function mergeSegments(segments: RecordingSegment[], gapMs = 2000): RecordingSegment[] {
  const merged: RecordingSegment[] = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    if (last && s.start.getTime() - last.end.getTime() <= gapMs) {
      if (s.end > last.end) last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Download of a recorded file (streamed through, never stored)
// ---------------------------------------------------------------------------
export async function downloadRecording(device: Device, playbackUri: string): Promise<Response> {
  const url = `${baseUrl(device)}/ISAPI/ContentMgmt/download`;
  const body = `<?xml version="1.0" encoding="UTF-8"?><downloadRequest version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><playbackURI>${escapeXml(playbackUri)}</playbackURI></downloadRequest>`;
  let res = await authorizedFetch(device, url, { method: "POST", body, headers: { "Content-Type": "application/xml; charset=UTF-8" }, timeoutMs: 30 * 60_000 });
  if (res.status === 405 || res.status === 400 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    res = await authorizedFetch(device, `${url}?playbackURI=${encodeURIComponent(playbackUri)}`, { timeoutMs: 30 * 60_000 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new IsapiError(`Recorder download failed: HTTP ${res.status} ${tag(text, "statusString") ?? ""}`.trim(), res.status);
  }
  return res;
}

/** RTSP playback URL of a track between two instants (credentials included; server-side only). */
export function playbackRtspUrl(device: Device, trackId: number, from: Date, to: Date, clock: DeviceClock): string {
  const { user, pass } = credentials(device);
  const auth = device.username ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  return `rtsp://${auth}${device.host}:${device.rtspPort}/Streaming/tracks/${trackId}?starttime=${toDeviceTime(from, clock, "compact")}&endtime=${toDeviceTime(to, clock, "compact")}`;
}
