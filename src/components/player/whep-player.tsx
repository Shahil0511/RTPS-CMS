"use client";

import { Camera as CameraIcon, Loader2, Maximize2, RefreshCw, Volume2, VolumeX, WifiOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/format";

type Phase = "idle" | "connecting" | "playing" | "error";
type Mode = "webrtc" | "hls";

interface StreamInfo {
  camera: { id: string; name: string; status: string; store: string; pathName: string };
  token: string;
  expiresAt: string;
  whepUrl: string;
  hlsUrl: string;
}

export interface WhepPlayerProps {
  cameraId: string;
  name?: string;
  storeName?: string;
  /** Start with WebRTC (lowest latency) or HLS (most compatible). */
  preferredMode?: Mode;
  muted?: boolean;
  compact?: boolean;
  className?: string;
  showLink?: boolean;
  onPhaseChange?: (phase: Phase) => void;
  /**
   * Endpoint returning {token, whepUrl, hlsUrl, camera}. Defaults to the live
   * stream of the camera; playback sessions pass their own endpoint.
   */
  tokenUrl?: string;
  /** Reconnect automatically after errors/disconnects (true for live, false for finite playback). */
  autoReconnect?: boolean;
  /** Called when a non-reconnecting stream ends or fails. */
  onEnded?: (reason: string) => void;
  /** Hide the LIVE indicator and reconnect/mode controls (playback). */
  playback?: boolean;
  /** Receives the JSON returned by the token endpoint (e.g. playback session id). */
  onStream?: (info: Record<string, unknown>) => void;
  /** Replaces the built-in restart (playback resumes from the current position instead of the original start). */
  onRestart?: () => void;
}

const MAX_WEBRTC_FAILURES_BEFORE_HLS = 2;

/**
 * Plays a camera through MediaMTX. Tries WHEP (WebRTC) first and falls back
 * to HLS automatically. Reconnects with exponential back-off.
 */
export function WhepPlayer({
  cameraId,
  name,
  storeName,
  preferredMode = "webrtc",
  muted = true,
  compact = false,
  className,
  showLink = true,
  onPhaseChange,
  tokenUrl,
  autoReconnect = true,
  onEnded,
  playback = false,
  onStream,
  onRestart,
}: WhepPlayerProps) {
  const endpoint = tokenUrl ?? `/api/stream/${cameraId}`;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const onStreamRef = useRef(onStream);
  onStreamRef.current = onStream;
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const sessionUrlRef = useRef<string | null>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const attemptRef = useRef(0);
  const failuresRef = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [mode, setMode] = useState<Mode>(preferredMode);
  // The effective mode lives in a ref so changing it never re-runs the mount effect mid-attempt.
  const modeRef = useRef<Mode>(preferredMode);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setMuted] = useState(muted);
  const [info, setInfo] = useState<StreamInfo["camera"] | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);

  const updatePhase = useCallback(
    (p: Phase) => {
      setPhase(p);
      onPhaseChange?.(p);
    },
    [onPhaseChange],
  );

  const teardown = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    const sessionUrl = sessionUrlRef.current;
    sessionUrlRef.current = null;
    if (sessionUrl) {
      fetch(sessionUrl, { method: "DELETE", headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {} }).catch(() => undefined);
    }
    const v = videoRef.current;
    if (v) {
      v.srcObject = null;
      v.removeAttribute("src");
      v.load();
    }
  }, []);

  const scheduleRetry = useCallback(
    (reason: string, attempt: number) => {
      if (attempt !== attemptRef.current) return;
      setError(reason);
      updatePhase("error");
      if (!autoReconnect) {
        onEndedRef.current?.(reason);
        return;
      }
      const delay = Math.min(30000, 1500 * 2 ** Math.min(failuresRef.current, 4));
      retryTimer.current = setTimeout(() => {
        void start();
      }, delay);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updatePhase, autoReconnect],
  );

  const startWebRTC = useCallback(
    async (stream: StreamInfo, attempt: number) => {
      const video = videoRef.current;
      if (!video) return;
      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (ev) => {
        if (attempt !== attemptRef.current) return;
        const [s] = ev.streams;
        if (s && video.srcObject !== s) {
          video.srcObject = s;
          video.play().catch(() => undefined);
        }
      };
      pc.onconnectionstatechange = () => {
        if (attempt !== attemptRef.current) return;
        if (pc.connectionState === "connected") {
          failuresRef.current = 0;
          setError(null);
          updatePhase("playing");
        } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
          failuresRef.current += 1;
          scheduleRetry("Connection lost", attempt);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 2000);
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(t);
            resolve();
          }
        };
      });
      if (attempt !== attemptRef.current) return;

      const res = await fetch(stream.whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp", Authorization: `Bearer ${stream.token}` },
        body: pc.localDescription?.sdp ?? "",
      });
      if (attempt !== attemptRef.current) return;
      if (res.status === 404) throw new Error("Stream is offline");
      if (res.status === 401 || res.status === 403) throw new Error("Not authorised for this stream");
      if (!res.ok && res.status !== 201) throw new Error(`WebRTC setup failed (${res.status})`);
      const location = res.headers.get("Location");
      if (location) sessionUrlRef.current = new URL(location, stream.whepUrl).toString();
      const answer = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    },
    [scheduleRetry, updatePhase],
  );

  const startHLS = useCallback(
    async (stream: StreamInfo, attempt: number) => {
      const video = videoRef.current;
      if (!video) return;
      const { default: Hls } = await import("hls.js");
      if (attempt !== attemptRef.current) return;
      if (!Hls.isSupported()) {
        throw new Error("HLS playback is not supported in this browser");
      }
      const hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 2,
        maxLiveSyncPlaybackRate: 1.5,
        xhrSetup: (xhr) => xhr.setRequestHeader("Authorization", `Bearer ${stream.token}`),
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (attempt !== attemptRef.current) return;
        video.play().catch(() => undefined);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (attempt !== attemptRef.current) return;
        failuresRef.current = 0;
        setError(null);
        updatePhase("playing");
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (attempt !== attemptRef.current || !data.fatal) return;
        failuresRef.current += 1;
        const reason = data.response?.code === 404 ? "Stream is offline" : `HLS error: ${data.details}`;
        scheduleRetry(reason, attempt);
      });
      hls.loadSource(stream.hlsUrl);
      hls.attachMedia(video);
    },
    [scheduleRetry, updatePhase],
  );

  const start = useCallback(async () => {
    teardown();
    const attempt = ++attemptRef.current;
    updatePhase("connecting");
    setError(null);
    try {
      const res = await fetch(endpoint, { cache: "no-store" });
      if (attempt !== attemptRef.current) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Could not get stream (${res.status})`);
      }
      const stream = (await res.json()) as StreamInfo;
      onStreamRef.current?.(stream as unknown as Record<string, unknown>);
      tokenRef.current = stream.token;
      setInfo(stream.camera);

      let useMode = modeRef.current;
      if (useMode === "webrtc" && failuresRef.current >= MAX_WEBRTC_FAILURES_BEFORE_HLS) {
        useMode = "hls";
        modeRef.current = "hls";
        setMode("hls");
      }
      if (useMode === "webrtc") await startWebRTC(stream, attempt);
      else await startHLS(stream, attempt);
    } catch (e) {
      if (attempt !== attemptRef.current) return;
      failuresRef.current += 1;
      const msg = e instanceof TypeError && /fetch/i.test(e.message) ? "Streaming server unreachable" : (e as Error).message;
      scheduleRetry(msg, attempt);
    }
  }, [endpoint, scheduleRetry, startHLS, startWebRTC, teardown, updatePhase]);

  useEffect(() => {
    void start();
    return () => {
      attemptRef.current += 1;
      teardown();
    };
  }, [start, teardown]);

  // Pause when the tab is hidden for a long time to save bandwidth; resume on return.
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      // Finite playback streams are not restarted from their original start time behind the viewer's back.
      if (!autoReconnect) return;
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60_000) void start();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [start, autoReconnect]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => setResolution(v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : null);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("resize", onMeta);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("resize", onMeta);
    };
  }, []);

  const switchMode = () => {
    failuresRef.current = 0;
    const next: Mode = modeRef.current === "webrtc" ? "hls" : "webrtc";
    modeRef.current = next;
    setMode(next);
    void start();
  };

  const snapshot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `${(info?.name ?? name ?? "camera").replace(/[^\w-]+/g, "_")}_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    a.click();
  };

  const fullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => undefined);
  };

  const title = info?.name ?? name ?? "Camera";

  return (
    <div ref={containerRef} className={cn("group relative overflow-hidden rounded-lg bg-black video-tile", className)}>
      <video ref={videoRef} autoPlay playsInline muted={isMuted} className="h-full w-full object-contain" />

      {/* Header overlay */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/70 to-transparent px-3 py-2 text-white">
        <div className="min-w-0">
          <p className={cn("truncate font-medium drop-shadow", compact ? "text-[12px]" : "text-sm")}>
            {showLink ? (
              <Link href={`/live/${cameraId}`} className="pointer-events-auto hover:underline">
                {title}
              </Link>
            ) : (
              title
            )}
          </p>
          {!compact && (storeName || info?.store) ? <p className="truncate text-[11px] text-white/70">{storeName ?? info?.store}</p> : null}
        </div>
        <div className="flex items-center gap-1.5">
          {phase === "playing" && !playback ? <span className="h-2 w-2 rounded-full bg-red-500 status-pulse text-red-500" title="Live" /> : null}
          {playback ? <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">Playback</span> : null}
          <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">{mode === "webrtc" ? "WebRTC" : "HLS"}</span>
          {resolution && !compact ? <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px]">{resolution}</span> : null}
        </div>
      </div>

      {/* Center state */}
      {phase !== "playing" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white">
          {phase === "connecting" || phase === "idle" ? (
            <>
              <Loader2 className="h-6 w-6 animate-spin text-white/80" />
              <p className="text-[12px] text-white/70">Connecting…</p>
            </>
          ) : (
            <>
              <WifiOff className="h-6 w-6 text-white/70" />
              <p className="max-w-[80%] text-center text-[12px] text-white/80">{playback && /lost|closed|offline/i.test(error ?? "") ? "End of recording" : (error ?? "Unavailable")}</p>
              {autoReconnect ? <p className="text-[11px] text-white/50">Retrying automatically</p> : null}
            </>
          )}
        </div>
      ) : null}

      {/* Controls */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <ControlButton label={isMuted ? "Unmute" : "Mute"} onClick={() => setMuted((m) => !m)}>
          {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </ControlButton>
        <ControlButton label="Snapshot" onClick={snapshot} disabled={phase !== "playing"}>
          <CameraIcon className="h-4 w-4" />
        </ControlButton>
        {!playback ? (
          <ControlButton label={`Switch to ${mode === "webrtc" ? "HLS" : "WebRTC"}`} onClick={switchMode}>
            <span className="text-[10px] font-bold">{mode === "webrtc" ? "HLS" : "RTC"}</span>
          </ControlButton>
        ) : null}
        <ControlButton label={playback ? "Restart" : "Reconnect"} onClick={() => (onRestart ? onRestart() : void start())}>
          <RefreshCw className="h-4 w-4" />
        </ControlButton>
        <ControlButton label="Fullscreen" onClick={fullscreen}>
          <Maximize2 className="h-4 w-4" />
        </ControlButton>
      </div>
    </div>
  );
}

function ControlButton({ label, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-md bg-white/10 text-white hover:bg-white/25 disabled:opacity-40"
      {...rest}
    >
      {children}
    </button>
  );
}
