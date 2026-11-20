import type { Metadata } from "next";
import { Suspense } from "react";
import { DevicesTable } from "@/components/devices/devices-table";
import { PageHeader } from "@/components/ui/page-header";
import { can, rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { listDevicesForUser } from "@/server/queries/devices";
import { storeOptionsForUser } from "@/server/queries/stores";

export const metadata: Metadata = { title: "Recorders" };
export const dynamic = "force-dynamic";

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ store?: string; q?: string }> }) {
  const user = await requireUser(rolesFor("devices.view"));
  const { store, q } = await searchParams;
  const [devices, stores] = await Promise.all([listDevicesForUser(user, { storeId: store ?? null, search: q ?? null }), storeOptionsForUser(user)]);

  return (
    <>
      <PageHeader title="Recorders" description="NVRs and DVRs per site. Channels are linked as cameras and inherit the recorder's address and credentials; footage stays on the recorder's disks." />
      <Suspense>
        <DevicesTable
          devices={devices.map((d) => ({
            id: d.id,
            storeId: d.storeId,
            storeName: d.store.name,
            storeCode: d.store.code,
            name: d.name,
            kind: d.kind,
            vendor: d.vendor,
            host: d.host,
            rtspPort: d.rtspPort,
            httpPort: d.httpPort,
            httpsEnabled: d.httpsEnabled,
            username: d.username,
            hasPassword: d.hasPassword,
            channelCount: d.channelCount,
            model: d.model,
            serialNumber: d.serialNumber,
            firmware: d.firmware,
            storageStatus: d.storageStatus,
            storageTotalMb: d.storageTotalMb,
            storageFreeMb: d.storageFreeMb,
            timeMode: d.timeMode,
            utcOffsetMinutes: d.utcOffsetMinutes,
            notes: d.notes,
            isEnabled: d.isEnabled,
            status: d.status,
            lastError: d.lastError,
            lastLatencyMs: d.lastLatencyMs,
            lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
            cameraCount: d.cameraCount,
            onlineCameraCount: d.onlineCameraCount,
          }))}
          stores={stores}
          canManage={can(user, "devices.manage")}
          filter={{ store: store ?? "", q: q ?? "" }}
        />
      </Suspense>
    </>
  );
}
