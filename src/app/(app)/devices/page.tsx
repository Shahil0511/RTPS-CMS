import type { Metadata } from "next";
import { Suspense } from "react";
import { DevicesTable } from "@/components/devices/devices-table";
import { deviceVendorId, maskSerial, recorderLinkState } from "@/components/health/connection-state";
import { PageHeader } from "@/components/ui/page-header";
import { CONNECTION_MODES, type ConnectionMode } from "@/db/schema";
import { can, rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { VENDORS, type VendorId } from "@/lib/vendors";
import { listDevicesForUser } from "@/server/queries/devices";
import { storeOptionsForUser } from "@/server/queries/stores";

export const metadata: Metadata = { title: "Recorders" };
export const dynamic = "force-dynamic";

const isMode = (v: string | undefined): v is ConnectionMode => Boolean(v) && (CONNECTION_MODES as readonly string[]).includes(v as string);
const isVendor = (v: string | undefined): v is VendorId => Boolean(v) && Object.prototype.hasOwnProperty.call(VENDORS, v as string);

export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ store?: string; q?: string; mode?: string; vendor?: string }> }) {
  const user = await requireUser(rolesFor("devices.view"));
  const { store, q, mode, vendor } = await searchParams;
  const [all, stores] = await Promise.all([listDevicesForUser(user, { storeId: store ?? null, search: q ?? null }), storeOptionsForUser(user)]);

  const modeFilter = isMode(mode) ? mode : null;
  const vendorFilter = isVendor(vendor) ? vendor : null;
  // Facet counts come from the store/search result, before the mode/vendor filters.
  const modeCounts = Object.fromEntries(CONNECTION_MODES.map((m) => [m, all.filter((d) => d.connectionMode === m).length])) as Record<ConnectionMode, number>;
  const vendorCounts: Partial<Record<VendorId, number>> = {};
  for (const d of all) {
    const v = deviceVendorId(d);
    vendorCounts[v] = (vendorCounts[v] ?? 0) + 1;
  }
  const devices = all.filter((d) => (!modeFilter || d.connectionMode === modeFilter) && (!vendorFilter || deviceVendorId(d) === vendorFilter));

  return (
    <>
      <PageHeader
        title="Recorders"
        description="NVRs and DVRs per site. Channels are linked as cameras and inherit the recorder's address and credentials; footage stays on the recorder's disks. Only Live recorders are monitored and alerted on."
      />
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
            vendorId: deviceVendorId(d),
            host: d.host,
            rtspPort: d.rtspPort,
            httpPort: d.httpPort,
            httpsEnabled: d.httpsEnabled,
            username: d.username,
            hasPassword: d.hasPassword,
            channelCount: d.channelCount,
            model: d.model,
            // Only the last four characters leave the server.
            serialMasked: maskSerial(d.serialNumber),
            firmware: d.firmware,
            storageStatus: d.storageStatus,
            storageTotalMb: d.storageTotalMb,
            storageFreeMb: d.storageFreeMb,
            timeMode: d.timeMode,
            utcOffsetMinutes: d.utcOffsetMinutes,
            notes: d.notes,
            isEnabled: d.isEnabled,
            connectionMode: d.connectionMode,
            cloudPlatform: d.cloudPlatform,
            cloudAccount: d.cloudAccount,
            linkState: recorderLinkState(d),
            status: d.status,
            lastError: d.lastError,
            lastLatencyMs: d.lastLatencyMs,
            lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
            cameraCount: d.cameraCount,
            onlineCameraCount: d.onlineCameraCount,
          }))}
          total={all.length}
          stores={stores}
          canManage={can(user, "devices.manage")}
          filter={{ store: store ?? "", q: q ?? "", mode: modeFilter ?? "", vendor: vendorFilter ?? "" }}
          facets={{ modes: modeCounts, vendors: vendorCounts }}
        />
      </Suspense>
    </>
  );
}
