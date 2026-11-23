import type { Metadata } from "next";
import { Suspense } from "react";
import { PlaybackBrowser } from "@/components/playback/playback-browser";
import { PageHeader } from "@/components/ui/page-header";
import { rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { listCamerasForUser } from "@/server/queries/cameras";

export const metadata: Metadata = { title: "Playback" };
export const dynamic = "force-dynamic";

export default async function PlaybackPage() {
  const user = await requireUser(rolesFor("playback.view"));
  const cameras = await listCamerasForUser(user);

  return (
    <>
      <PageHeader
        title="Playback"
        description="Footage is read directly from each site's NVR/DVR on demand, so no recording storage is needed on this server."
      />
      <Suspense>
        <PlaybackBrowser
          canDownload={user.canDownload}
          cameras={cameras.map((c) => ({
            id: c.id,
            name: c.name,
            store: c.store.name,
            status: c.status,
            playbackMode: c.playbackMode,
            recorder: c.device?.name ?? null,
          }))}
        />
      </Suspense>
    </>
  );
}
