import type { Metadata } from "next";
import { StoresTable } from "@/components/stores/stores-table";
import { PageHeader } from "@/components/ui/page-header";
import { can, rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { listStoreEstateForUser } from "@/server/queries/stores";

export const metadata: Metadata = { title: "Stores" };
export const dynamic = "force-dynamic";

export default async function StoresPage() {
  const user = await requireUser(rolesFor("cameras.view"));
  const stores = await listStoreEstateForUser(user);
  const recorders = stores.reduce((a, s) => a + s.recorderCount, 0);
  const live = stores.reduce((a, s) => a + (s.recorderStates.LIVE ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Stores & locations"
        description={`Every store, warehouse and office with its recorders' make and connection state${recorders ? ` · ${live} of ${recorders} recorders live` : ""}. Recorders marked Pending network or Cloud-only are listed but not monitored.`}
      />
      <StoresTable stores={stores} canManage={can(user, "stores.manage")} />
    </>
  );
}
