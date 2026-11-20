import { ArrowLeft, Film } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { WhepPlayer } from "@/components/player/whep-player";
import { StatusBadge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { formatDateTime, formatRelative } from "@/lib/format";
import { uptimeFor } from "@/lib/health/monitor";
import { getCameraForUser } from "@/server/queries/cameras";

export const metadata: Metadata = { title: "Camera" };
export const dynamic = "force-dynamic";

export default async function CameraLivePage({ params }: { params: Promise<{ cameraId: string }> }) {
  const user = await requireUser(rolesFor("live.view"));
  const { cameraId } = await params;
  const camera = await getCameraForUser(user, cameraId);
  if (!camera) notFound();
  const uptime = (await uptimeFor([camera.id], new Date(Date.now() - 24 * 3600 * 1000))).get(camera.id) ?? null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/live" className={buttonClasses("ghost", "sm")}>
            <ArrowLeft className="h-4 w-4" /> Live view
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">{camera.name}</h1>
          <StatusBadge status={camera.status} enabled={camera.isEnabled} />
        </div>
        <Link href={`/playback?camera=${camera.id}`} className={buttonClasses("secondary", "sm")}>
          <Film className="h-4 w-4" /> Recordings
        </Link>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <div>
          {camera.isEnabled ? (
            <WhepPlayer cameraId={camera.id} name={camera.name} storeName={camera.store.name} showLink={false} className="w-full" />
          ) : (
            <div className="video-tile grid place-items-center rounded-lg text-sm text-white/70">This camera is disabled.</div>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <dl className="space-y-2 text-sm">
                <Row k="Store" v={`${camera.store.name} (${camera.store.code})`} />
                <Row k="Device" v={`${camera.host}:${camera.port}`} mono />
                <Row k="Stream path" v={camera.pathName} mono />
                <Row k="Video" v={camera.videoCodec ? `${camera.videoCodec}${camera.resolution ? ` · ${camera.resolution}` : ""}` : "—"} />
                <Row k="Audio" v={camera.audioCodec ?? "—"} />
                <Row k="Transport" v={camera.transport.toUpperCase()} />
                <Row k="Recording" v={camera.recordEnabled ? `On · ${camera.retentionDays} day retention` : "Off"} />
                <Row k="Viewers" v={String(camera.readerCount)} />
              </dl>
              {camera.description ? <p className="mt-3 text-[13px] text-muted">{camera.description}</p> : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Health" />
            <CardBody>
              <dl className="space-y-2 text-sm">
                <Row k="Uptime (24h)" v={uptime === null ? "—" : `${uptime}%`} />
                <Row k="Last check" v={formatRelative(camera.lastCheckedAt)} />
                <Row k="Last online" v={camera.lastOnlineAt ? formatDateTime(camera.lastOnlineAt) : "never"} />
                <Row k="Latency" v={camera.lastLatencyMs != null ? `${camera.lastLatencyMs} ms` : "—"} />
              </dl>
              {camera.lastError ? <p className="mt-3 rounded-md bg-danger-soft px-2.5 py-2 text-[12px] text-danger">{camera.lastError}</p> : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-muted">{k}</dt>
      <dd className={`truncate text-right text-text ${mono ? "font-mono text-[12.5px]" : ""}`} title={v}>
        {v}
      </dd>
    </div>
  );
}
