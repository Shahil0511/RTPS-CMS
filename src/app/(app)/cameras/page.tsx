import type { Metadata } from "next";
import { Suspense } from "react";
import { CamerasTable } from "@/components/cameras/cameras-table";
import { PageHeader } from "@/components/ui/page-header";
import { env } from "@/env";
import { can, rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { listCamerasForUser } from "@/server/queries/cameras";
import { deviceVendorId, recorderLinkState, vendorLabel } from "@/components/health/connection-state";
import { deviceOptionsForUser, listDevicesForUser } from "@/server/queries/devices";
import { storeOptionsForUser } from "@/server/queries/stores";

export const metadata: Metadata = { title: "Cameras" };
export const dynamic = "force-dynamic";

export default async function CamerasPage({ searchParams }: { searchParams: Promise<{ store?: string; device?: string; q?: string }> }) {
  const user = await requireUser(rolesFor("cameras.view"));
  const { store, device, q } = await searchParams;
  const [cameras, stores, devices, recorders] = await Promise.all([
    listCamerasForUser(user, { storeId: store ?? null, deviceId: device ?? null, search: q ?? null }),
    storeOptionsForUser(user),
    deviceOptionsForUser(user),
    listDevicesForUser(user, { storeId: store ?? null }),
  ]);
  // Vendor and connection state of each camera's parent recorder (store-scoped like the cameras).
  const recorderInfo = new Map(recorders.map((d) => [d.id, { vendor: vendorLabel(deviceVendorId(d)), linkState: recorderLinkState(d) }]));

  return (
    <>
      <PageHeader title="Cameras" description="Camera inventory. Channels inherit their recorder's address and credentials; each camera is registered with the streaming server automatically." />
      <Suspense>
        <CamerasTable
          cameras={cameras.map((c) => ({
            id: c.id,
            storeId: c.storeId,
            storeName: c.store.name,
            storeCode: c.store.code,
            name: c.name,
            pathName: c.pathName,
            description: c.description,
            deviceId: c.deviceId,
            deviceName: c.device?.name ?? null,
            deviceVendor: c.deviceId ? (recorderInfo.get(c.deviceId)?.vendor ?? null) : null,
            deviceLinkState: c.deviceId ? (recorderInfo.get(c.deviceId)?.linkState ?? null) : null,
            channel: c.channel,
            host: c.host,
            port: c.port,
            username: c.username,
            hasPassword: Boolean(c.passwordEnc),
            rtspPath: c.rtspPath,
            transport: c.transport,
            recordEnabled: c.recordEnabled,
            retentionDays: c.retentionDays,
            isEnabled: c.isEnabled,
            sortOrder: c.sortOrder,
            status: c.status,
            lastError: c.lastError,
            videoCodec: c.videoCodec,
            resolution: c.resolution,
            lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
          }))}
          stores={stores}
          devices={devices}
          canManage={can(user, "cameras.manage")}
          defaults={{ recordEnabled: env.DEFAULT_RECORD_ENABLED, retentionDays: env.DEFAULT_RETENTION_DAYS }}
          filter={{ store: store ?? "", device: device ?? "", q: q ?? "" }}
        />
      </Suspense>
    </>
  );
}
