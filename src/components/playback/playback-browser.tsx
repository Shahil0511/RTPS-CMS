"use client";

import { Download, Film, HardDrive, Loader2, Lock, Play, RotateCcw, RotateCw, Square } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WhepPlayer } from "@/components/player/whep-player";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { CameraStatus, PlaybackMode } from "@/db/schema";
import { cn, formatDuration, formatTime, toLocalDateInputValue } from "@/lib/format";
import { VIEW_ONLY_CLIP_SECONDS } from "@/lib/playback/limits";

export interface PlaybackCamera {
  id: string;
  name: string;
  store: string;
  status: CameraStatus;
  playbackMode: PlaybackMode;
  recorder: string | null;
}

interface Span {
  start: string;
  end: string;
  duration: number;
}

interface SegmentsResponse {
  source: "nvr" | "local" | "none";
  items: Span[];
  files: Span[];
  totalSeconds: number;
  recorder?: { name: string; timeMode: string; utcOffsetMinutes: number };
  error?: string;
  detail?: string;
}

interface Playing {
  key: number;
  start: Date;
  end: Date;
}

/** Seconds requested from /media for a local clip; view-only accounts are served in VIEW_ONLY_CLIP_SECONDS windows. */
function localClipSeconds(p: Playing, canDownload: boolean): number {
  const total = (p.end.getTime() - p.start.getTime()) / 1000;
  return canDownload ? total : Math.min(total, VIEW_ONLY_CLIP_SECONDS);
}

const DAY_MS = 86400_000;

/**
 * Playback that reads footage from the recorder (NVR/DVR) on demand: the
 * timeline comes from the recorder's own index and video is streamed live
 * from its disks, so this server stores nothing. LOCAL cameras fall back to
 * the streaming server's recordings.
 */
/** canDownload = the user's effective footage-download right (server enforces it too). */
export function PlaybackBrowser({ cameras, canDownload }: { cameras: PlaybackCamera[]; canDownload: boolean }) {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const initialCamera = sp.get("camera") && cameras.some((c) => c.id === sp.get("camera")) ? (sp.get("camera") as string) : (cameras[0]?.id ?? "");

  const [cameraId, setCameraId] = useState(initialCamera);
  const [date, setDate] = useState(() => toLocalDateInputValue(new Date()));
  const [data, setData] = useState<SegmentsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState<string>("idle");
  const sessionRef = useRef<string | null>(null);
  /** Seconds actually played in finished "playing" stretches, and when the current stretch began. */
  const playedRef = useRef(0);
  const playingSinceRef = useRef<number | null>(null);
  const keyRef = useRef(0);
  const loadSeq = useRef(0);

  const camera = cameras.find((c) => c.id === cameraId) ?? null;
  const dayStart = useMemo(() => new Date(`${date}T00:00:00`), [date]);
  const dayEnd = useMemo(() => new Date(dayStart.getTime() + DAY_MS), [dayStart]);

  // ---- session lifecycle -------------------------------------------------
  const closeSession = useCallback(() => {
    const id = sessionRef.current;
    sessionRef.current = null;
    if (!id) return;
    void fetch(`/api/playback/session/${id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onHide = () => {
      const id = sessionRef.current;
      if (id && navigator.sendBeacon) navigator.sendBeacon(`/api/playback/session/${id}`);
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      closeSession();
    };
  }, [closeSession]);

  const resetClock = useCallback(() => {
    playedRef.current = 0;
    playingSinceRef.current = null;
    setElapsed(0);
  }, []);

  const stop = useCallback(() => {
    closeSession();
    setPlaying(null);
    resetClock();
  }, [closeSession, resetClock]);

  // ---- load recordings ---------------------------------------------------
  /** Reads the recorder's index; only the latest request may update the screen. */
  const fetchSegments = useCallback(async (): Promise<SegmentsResponse | null> => {
    if (!cameraId) return null;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from: dayStart.toISOString(), to: dayEnd.toISOString() });
      const res = await fetch(`/api/playback/${cameraId}/segments?${qs}`, { cache: "no-store" });
      const json = (await res.json()) as SegmentsResponse;
      if (seq !== loadSeq.current) return null;
      if (!res.ok) throw new Error(json.detail ? `${json.error}: ${json.detail}` : (json.error ?? "Failed to load recordings"));
      setData(json);
      return json;
    } catch (e) {
      if (seq !== loadSeq.current) return null;
      setData(null);
      setError((e as Error).message);
      return null;
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [cameraId, dayStart, dayEnd]);

  const load = useCallback(async () => {
    stop();
    await fetchSegments();
  }, [fetchSegments, stop]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (cameraId) url.searchParams.set("camera", cameraId);
    router.replace(url.pathname + url.search, { scroll: false });
  }, [cameraId, router]);

  // ---- playback clock: counts only time spent actually playing ----------
  const onPhase = useCallback((p: string) => {
    setPhase(p);
    if (p === "playing") {
      if (playingSinceRef.current === null) playingSinceRef.current = Date.now();
    } else if (playingSinceRef.current !== null) {
      playedRef.current += (Date.now() - playingSinceRef.current) / 1000;
      playingSinceRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!playing || phase !== "playing") return;
    const t = setInterval(() => {
      const live = playingSinceRef.current === null ? 0 : (Date.now() - playingSinceRef.current) / 1000;
      setElapsed(playedRef.current + live);
    }, 500);
    return () => clearInterval(t);
  }, [playing, phase]);

  const items = data?.items ?? [];
  const files = data?.files ?? [];

  const begin = useCallback(
    (start: Date, end: Date) => {
      closeSession();
      resetClock();
      setPhase("connecting");
      keyRef.current += 1;
      setPlaying({ key: keyRef.current, start, end });
    },
    [closeSession, resetClock],
  );

  const playFrom = useCallback(
    (t: Date, spans: Span[] = items) => {
      if (!camera) return;
      // Snap into the nearest recorded block at or after t.
      const within = spans.find((s) => t.getTime() >= new Date(s.start).getTime() && t.getTime() < new Date(s.end).getTime());
      const block = within ?? spans.find((s) => new Date(s.start).getTime() > t.getTime()) ?? null;
      if (!block) {
        toast.error("No recording after that time");
        return;
      }
      begin(within ? t : new Date(block.start), new Date(block.end));
    },
    [begin, camera, items, toast],
  );

  const position = playing ? new Date(playing.start.getTime() + elapsed * 1000) : null;
  const jump = (seconds: number) => {
    if (!position) return;
    const target = new Date(Math.max(dayStart.getTime(), Math.min(Date.now() - 10_000, position.getTime() + seconds * 1000)));
    playFrom(target);
  };

  const quick = async (minutesAgo: number) => {
    const target = new Date(Date.now() - minutesAgo * 60_000);
    if (toLocalDateInputValue(target) !== date) {
      setDate(toLocalDateInputValue(target));
      toast.info("Switched day", "Pick the time again on the timeline.");
      return;
    }
    // The index loaded earlier ends at load time; refresh it so recent footage is included.
    const fresh = await fetchSegments();
    if (fresh) playFrom(target, fresh.items);
  };

  const sessionUrl = playing
    ? `/api/playback/${cameraId}/session?${new URLSearchParams({ start: playing.start.toISOString(), end: playing.end.toISOString() }).toString()}`
    : null;
  const isNvr = data?.source === "nvr" || camera?.playbackMode === "NVR";

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <Card>
          <CardBody className="flex flex-wrap items-end gap-3 pt-4">
            <Field label="Camera" className="min-w-56 flex-1">
              <Select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
                {cameras.length === 0 ? <option value="">No cameras available</option> : null}
                {cameras.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.store}
                    {c.playbackMode === "NONE" ? " (no playback)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date" className="w-44">
              <Input type="date" value={date} max={toLocalDateInputValue(new Date())} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </Field>
            <div className="flex gap-2 pb-0.5">
              <Button variant="secondary" onClick={() => setDate(toLocalDateInputValue(new Date(dayStart.getTime() - DAY_MS)))}>
                ‹ Prev
              </Button>
              <Button variant="secondary" onClick={() => setDate(toLocalDateInputValue(new Date(Math.min(Date.now(), dayStart.getTime() + DAY_MS))))}>
                Next ›
              </Button>
            </div>
            <div className="ml-auto flex items-center gap-2 pb-1 text-[13px] text-muted">
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading recorder…
                </span>
              ) : (
                <>
                  {isNvr ? (
                    <Badge tone="info">
                      <HardDrive className="h-3 w-3" /> From recorder
                    </Badge>
                  ) : data?.source === "local" ? (
                    <Badge>Local recording</Badge>
                  ) : null}
                  <span>
                    {items.length} block{items.length === 1 ? "" : "s"} · {formatDuration(data?.totalSeconds ?? 0)}
                  </span>
                </>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Timeline"
            description="Click anywhere on a green block to play from that moment. Video is streamed from the recorder's disks; nothing is stored here."
            action={
              isNvr ? (
                <div className="flex gap-1.5">
                  <Button variant="secondary" size="sm" onClick={() => quick(15)}>
                    Last 15 min
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => quick(60)}>
                    Last hour
                  </Button>
                </div>
              ) : null
            }
          />
          <CardBody>
            <Timeline spans={items} dayStart={dayStart} current={position} onPick={playFrom} />
          </CardBody>
        </Card>

        {/* Player */}
        <div className="overflow-hidden rounded-lg bg-black">
          {playing && isNvr && sessionUrl ? (
            <WhepPlayer
              key={playing.key}
              cameraId={cameraId}
              name={camera?.name}
              storeName={camera?.store}
              tokenUrl={sessionUrl}
              autoReconnect={false}
              playback
              showLink={false}
              onPhaseChange={onPhase}
              onRestart={() => (position ? playFrom(position) : undefined)}
              onStream={(info) => {
                sessionRef.current = typeof info.sessionId === "string" ? info.sessionId : null;
              }}
              onEnded={(reason) => {
                if (/lost|closed|offline|unreachable/i.test(reason)) toast.info("Playback ended", reason);
              }}
            />
          ) : playing && data?.source === "local" ? (
            <video
              key={playing.key}
              src={`/api/playback/${cameraId}/media?${new URLSearchParams({ start: playing.start.toISOString(), duration: String(localClipSeconds(playing, canDownload)) })}`}
              controls
              // Hide the browser's own "Download" menu entry when the account may not download footage.
              controlsList={canDownload ? undefined : "nodownload"}
              onContextMenu={canDownload ? undefined : (e) => e.preventDefault()}
              autoPlay
              playsInline
              className="video-tile w-full"
              onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
              onPlaying={() => onPhase("playing")}
              // View-only accounts get the block in windows (the server caps each one): continue with the next.
              onEnded={() => {
                const next = new Date(playing.start.getTime() + localClipSeconds(playing, canDownload) * 1000);
                if (next.getTime() < playing.end.getTime() - 1000) begin(next, playing.end);
              }}
            />
          ) : (
            <div className="video-tile grid place-items-center text-sm text-white/60">
              {error ? (
                <span className="max-w-lg px-4 text-center text-red-300">{error}</span>
              ) : camera?.playbackMode === "NONE" ? (
                "Playback is disabled for this camera."
              ) : items.length ? (
                "Pick a time on the timeline to start playback"
              ) : loading ? (
                "Reading the recorder's index…"
              ) : (
                "No recordings on the recorder for this day"
              )}
            </div>
          )}
        </div>

        {playing ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto text-[13px] text-muted">
              <span className="font-medium text-text">{camera?.name}</span> ·{" "}
              <span className="font-mono tabular-nums text-text">{position ? position.toLocaleString() : "—"}</span>
              {phase !== "playing" ? <span className="ml-2 text-faint">connecting to recorder…</span> : null}
            </div>
            {isNvr ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => jump(-300)} title="Back 5 minutes">
                  <RotateCcw className="h-4 w-4" /> 5m
                </Button>
                <Button variant="secondary" size="sm" onClick={() => jump(-30)} title="Back 30 seconds">
                  <RotateCcw className="h-4 w-4" /> 30s
                </Button>
                <Button variant="secondary" size="sm" onClick={() => jump(30)} title="Forward 30 seconds">
                  30s <RotateCw className="h-4 w-4" />
                </Button>
                <Button variant="secondary" size="sm" onClick={() => jump(300)} title="Forward 5 minutes">
                  5m <RotateCw className="h-4 w-4" />
                </Button>
              </>
            ) : null}
            <Button variant="danger" size="sm" onClick={stop}>
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader
            title="Recordings"
            description={camera ? `${camera.name} · ${dayStart.toLocaleDateString()}${camera.recorder ? ` · ${camera.recorder}` : ""}` : undefined}
          />
          <CardBody className="px-0 pb-0">
            {files.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyState
                  icon={<Film className="h-5 w-5" />}
                  title={error ? "Recorder not reachable" : "Nothing recorded"}
                  description={error ? "Check the recorder's address and login on the Recorders page." : "The recorder has no footage for this camera on this day."}
                />
              </div>
            ) : (
              <ul className="max-h-[56vh] divide-y divide-border overflow-y-auto">
                {files.map((f) => {
                  const active = playing && position && position.getTime() >= new Date(f.start).getTime() && position.getTime() < new Date(f.end).getTime();
                  return (
                    <li key={`${f.start}-${f.end}`} className={cn("flex items-center gap-2 px-4 py-2.5", active && "bg-accent-soft/60")}>
                      <button type="button" onClick={() => playFrom(new Date(f.start))} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-md", active ? "bg-accent text-white" : "bg-surface-2 text-muted")}>
                          <Play className="h-4 w-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-text">
                            {formatTime(f.start)} – {formatTime(f.end)}
                          </span>
                          <span className="block text-[12px] text-faint">{formatDuration(f.duration)}</span>
                        </span>
                      </button>
                      {canDownload && data?.source === "nvr" ? (
                        <a
                          href={`/api/playback/${cameraId}/download?${new URLSearchParams({ start: f.start, end: f.end })}`}
                          className={buttonClasses("ghost", "icon")}
                          title="Download this file from the recorder"
                          aria-label="Download from recorder"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {data?.recorder ? (
          <Card>
            <CardHeader title="Recorder" />
            <CardBody className="space-y-1.5 text-[13px] text-muted">
              <p>
                <span className="text-faint">Source:</span> <span className="text-text">{data.recorder.name}</span>
              </p>
              <p>
                <span className="text-faint">Clock:</span> {data.recorder.timeMode === "utc" ? "UTC" : "local time"} (UTC{data.recorder.utcOffsetMinutes >= 0 ? "+" : "-"}
                {Math.floor(Math.abs(data.recorder.utcOffsetMinutes) / 60)}:{String(Math.abs(data.recorder.utcOffsetMinutes) % 60).padStart(2, "0")})
              </p>
              <p className="text-[12px] text-faint">If footage plays from the wrong time, change the recorder&apos;s clock setting on the Recorders page.</p>
              {canDownload ? (
                <p className="text-[12px] text-faint">Downloaded files are in the recorder&apos;s native format; VLC plays them directly.</p>
              ) : (
                <p className="inline-flex items-center gap-1.5 text-[12px] text-faint">
                  <Lock className="h-3.5 w-3.5" /> Downloading footage is not enabled for your account.
                </p>
              )}
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function Timeline({ spans, dayStart, current, onPick }: { spans: Span[]; dayStart: Date; current: Date | null; onPick: (t: Date) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: Date } | null>(null);
  const pct = (d: Date) => Math.max(0, Math.min(100, ((d.getTime() - dayStart.getTime()) / DAY_MS) * 100));
  const timeAt = (clientX: number): Date | null => {
    const el = ref.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return new Date(dayStart.getTime() + f * DAY_MS);
  };

  return (
    <div>
      <div
        ref={ref}
        role="slider"
        aria-label="Recording timeline"
        aria-valuemin={0}
        aria-valuemax={24}
        aria-valuenow={current ? (current.getTime() - dayStart.getTime()) / 3600_000 : 0}
        tabIndex={0}
        className="relative h-12 w-full cursor-pointer overflow-hidden rounded-[4px] bg-[var(--timeline-bg)]"
        onMouseMove={(e) => {
          const t = timeAt(e.clientX);
          const r = ref.current?.getBoundingClientRect();
          if (t && r) setHover({ x: e.clientX - r.left, t });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const t = timeAt(e.clientX);
          if (t) onPick(t);
        }}
      >
        {Array.from({ length: 23 }, (_, i) => (
          <div key={i} className="pointer-events-none absolute inset-y-0 w-px bg-white/5" style={{ left: `${((i + 1) / 24) * 100}%` }} />
        ))}
        {spans.map((s) => {
          const left = pct(new Date(s.start));
          const width = Math.max(0.2, pct(new Date(s.end)) - left);
          return <div key={s.start} className="pointer-events-none absolute inset-y-2 rounded-sm bg-success/80" style={{ left: `${left}%`, width: `${width}%` }} />;
        })}
        {current ? <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${pct(current)}%` }} /> : null}
        {hover ? (
          <>
            <div className="pointer-events-none absolute inset-y-0 w-px bg-accent" style={{ left: hover.x }} />
            <div className="pointer-events-none absolute top-0.5 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white" style={{ left: hover.x }}>
              {hover.t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>
          </>
        ) : null}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-faint">
        {Array.from({ length: 9 }, (_, i) => i * 3).map((h) => (
          <span key={h} className={cn("absolute", h === 0 ? "" : h === 24 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${(h / 24) * 100}%` }}>
            {h.toString().padStart(2, "0")}:00
          </span>
        ))}
      </div>
    </div>
  );
}
