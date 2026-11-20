import type { Metadata } from "next";
import { Suspense } from "react";
import { LiveGrid } from "@/components/live/live-grid";
import { PageHeader } from "@/components/ui/page-header";
import { rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { listCamerasForUser } from "@/server/queries/cameras";
import { storeOptionsForUser } from "@/server/queries/stores";

export const metadata: Metadata = { title: "Live view" };
export const dynamic = "force-dynamic";

export default async function LivePage() {
  const user = await requireUser(rolesFor("live.view"));
  const [cameras, sites] = await Promise.all([listCamerasForUser(user, { enabledOnly: true }), storeOptionsForUser(user)]);
  const kindOf = new Map(sites.map((s) => [s.id, s.kind]));

  return (
    <>
      <PageHeader title="Live view" description="Stores and corporate sites side by side. Low-latency WebRTC streaming with automatic HLS fallback; layouts are remembered per site." />
      <Suspense>
        <LiveGrid
          userId={user.id}
          sites={sites.map((s) => ({ id: s.id, name: s.name, code: s.code, kind: s.kind }))}
          cameras={cameras.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            isEnabled: c.isEnabled,
            store: { id: c.store.id, name: c.store.name, code: c.store.code, kind: kindOf.get(c.store.id) ?? "STORE" },
          }))}
        />
      </Suspense>
    </>
  );
}
