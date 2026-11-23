import "server-only";
import { env } from "@/env";

/**
 * Thin typed client for the MediaMTX Control API (v3) and playback server.
 * Authenticates with the service account that the auth hook recognises.
 */

export interface MtxPathConf {
  name?: string;
  source?: string;
  sourceOnDemand?: boolean;
  sourceOnDemandStartTimeout?: string;
  sourceOnDemandCloseAfter?: string;
  rtspRangeType?: "" | "clock" | "npt" | "smpte";
  rtspRangeStart?: string;
  rtspTransport?: "automatic" | "udp" | "multicast" | "tcp";
  record?: boolean;
  recordDeleteAfter?: string;
  recordSegmentDuration?: string;
  recordPath?: string;
  maxReaders?: number;
}

export interface MtxTrack {
  codec: string;
  codecProps?: Record<string, unknown> | null;
}

export interface MtxPath {
  name: string;
  confName: string;
  online: boolean;
  onlineTime: string | null;
  ready?: boolean;
  readyTime?: string | null;
  source: { type: string; id: string } | null;
  tracks2?: MtxTrack[];
  tracks?: string[];
  readers: Array<{ type: string; id: string }>;
  inboundBytes?: number;
  outboundBytes?: number;
  bytesReceived?: number;
  bytesSent?: number;
}

export interface MtxInfo {
  version: string;
  [key: string]: unknown;
}

export interface MtxRecordingSegment {
  start: string;
  duration: number | null;
  url?: string;
}

export class MediaMtxError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
  }
}

function basicAuth(): string {
  return "Basic " + Buffer.from(`${env.MEDIAMTX_API_USER}:${env.MEDIAMTX_API_PASS}`).toString("base64");
}

export const mediaMtxAuthHeaders = (): Record<string, string> => ({ Authorization: basicAuth() });

async function api<T>(method: "GET" | "POST" | "PATCH" | "DELETE", route: string, body?: unknown): Promise<T> {
  const url = `${env.MEDIAMTX_API_URL.replace(/\/$/, "")}${route}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: basicAuth(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new MediaMtxError(`MediaMTX ${method} ${route} failed: ${res.status} ${text}`.trim(), res.status, text);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const mtx = {
  info: () => api<MtxInfo>("GET", "/v3/info"),

  listPaths: async (): Promise<MtxPath[]> => {
    const out: MtxPath[] = [];
    let page = 0;
    for (;;) {
      const res = await api<{ pageCount: number; items: MtxPath[] }>(
        "GET",
        `/v3/paths/list?itemsPerPage=500&page=${page}`,
      );
      out.push(...(res.items ?? []));
      page += 1;
      if (page >= (res.pageCount ?? 1)) break;
    }
    return out;
  },

  getPath: async (name: string): Promise<MtxPath | null> => {
    try {
      return await api<MtxPath>("GET", `/v3/paths/get/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e instanceof MediaMtxError && e.status === 404) return null;
      throw e;
    }
  },

  listPathConfs: async (): Promise<MtxPathConf[]> => {
    const out: MtxPathConf[] = [];
    let page = 0;
    for (;;) {
      const res = await api<{ pageCount: number; items: MtxPathConf[] }>(
        "GET",
        `/v3/config/paths/list?itemsPerPage=500&page=${page}`,
      );
      out.push(...(res.items ?? []));
      page += 1;
      if (page >= (res.pageCount ?? 1)) break;
    }
    return out;
  },

  getPathConf: async (name: string): Promise<MtxPathConf | null> => {
    try {
      return await api<MtxPathConf>("GET", `/v3/config/paths/get/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e instanceof MediaMtxError && e.status === 404) return null;
      throw e;
    }
  },

  addPath: (name: string, conf: MtxPathConf) =>
    api<void>("POST", `/v3/config/paths/add/${encodeURIComponent(name)}`, conf),

  replacePath: (name: string, conf: MtxPathConf) =>
    api<void>("POST", `/v3/config/paths/replace/${encodeURIComponent(name)}`, conf),

  patchPath: (name: string, conf: MtxPathConf) =>
    api<void>("PATCH", `/v3/config/paths/patch/${encodeURIComponent(name)}`, conf),

  deletePath: async (name: string): Promise<void> => {
    try {
      await api<void>("DELETE", `/v3/config/paths/delete/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e instanceof MediaMtxError && e.status === 404) return;
      throw e;
    }
  },

  /** Lists recorded segments on disk for a path (Control API). */
  recordingSegments: async (name: string): Promise<MtxRecordingSegment[]> => {
    try {
      const res = await api<{ name: string; segments: MtxRecordingSegment[] }>(
        "GET",
        `/v3/recordings/get/${encodeURIComponent(name)}`,
      );
      return res.segments ?? [];
    } catch (e) {
      if (e instanceof MediaMtxError && e.status === 404) return [];
      throw e;
    }
  },

  /** Lists playable timespans between two instants (playback server). */
  playbackList: async (name: string, start?: Date, end?: Date): Promise<MtxRecordingSegment[]> => {
    const params = new URLSearchParams({ path: name });
    if (start) params.set("start", start.toISOString());
    if (end) params.set("end", end.toISOString());
    const url = `${env.MEDIAMTX_PLAYBACK_URL.replace(/\/$/, "")}/list?${params.toString()}`;
    const res = await fetch(url, {
      headers: { Authorization: basicAuth() },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new MediaMtxError(`Playback list failed: ${res.status}`, res.status, await res.text().catch(() => ""));
    }
    return (await res.json()) as MtxRecordingSegment[];
  },

  /** Builds the internal playback URL used by the media proxy. */
  playbackGetUrl: (name: string, start: Date, durationSeconds: number, format: "fmp4" | "mp4" = "fmp4"): string => {
    const params = new URLSearchParams({
      path: name,
      start: start.toISOString(),
      duration: String(durationSeconds),
      format,
    });
    return `${env.MEDIAMTX_PLAYBACK_URL.replace(/\/$/, "")}/get?${params.toString()}`;
  },

  /**
   * Disconnects the long-lived readers of a path (WebRTC, RTSP/RTSPS, RTMP/RTMPS, SRT); they must
   * authenticate again to reconnect. HLS has no per-reader connection: every HLS request is
   * authorised on its own, so revoked access stops there without a kick. Returns readers kicked.
   */
  kickReaders: async (path: Pick<MtxPath, "readers">): Promise<number> => {
    const routes: Record<string, string> = {
      webRTCSession: "webrtcsessions",
      rtspSession: "rtspsessions",
      rtspsSession: "rtspssessions",
      rtmpConn: "rtmpconns",
      rtmpsConn: "rtmpsconns",
      srtConn: "srtconns",
    };
    let kicked = 0;
    for (const r of path.readers ?? []) {
      const route = routes[r.type];
      if (!route || !r.id) continue;
      try {
        await api<void>("POST", `/v3/${route}/kick/${encodeURIComponent(r.id)}`);
        kicked += 1;
      } catch (e) {
        // Already gone (404) is fine; anything else is retried by the next revocation or the token expiry.
        if (!(e instanceof MediaMtxError && e.status === 404)) throw e;
      }
    }
    return kicked;
  },

  /** Kicks every reader/session of a path by replacing its configuration (forces a source reconnect). */
  restartPath: async (name: string): Promise<void> => {
    const conf = await mtx.getPathConf(name);
    if (!conf) return;
    await mtx.deletePath(name);
    const { name: _ignored, ...rest } = conf;
    await mtx.addPath(name, rest);
  },
};

export function describeTracks(tracks?: MtxTrack[] | string[]): {
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
} {
  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let resolution: string | null = null;
  const VIDEO = new Set(["H264", "H265", "AV1", "VP8", "VP9", "MJPEG", "MPEG-4 Video", "MPEG-1/2 Video"]);
  for (const t of tracks ?? []) {
    const codec = typeof t === "string" ? t : t.codec;
    const props = typeof t === "string" ? null : (t.codecProps ?? null);
    if (VIDEO.has(codec)) {
      if (!videoCodec) {
        videoCodec = codec;
        const w = props?.width;
        const h = props?.height;
        if (typeof w === "number" && typeof h === "number" && w > 0 && h > 0) resolution = `${w}x${h}`;
      }
    } else if (!audioCodec) {
      audioCodec = codec;
    }
  }
  return { videoCodec, audioCodec, resolution };
}
