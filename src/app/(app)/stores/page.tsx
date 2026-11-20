import type { Metadata } from "next";
import { StoresTable } from "@/components/stores/stores-table";
import { PageHeader } from "@/components/ui/page-header";
import { can, rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { listStoresForUser } from "@/server/queries/stores";

export const metadata: Metadata = { title: "Stores" };
export const dynamic = "force-dynamic";

export default async function StoresPage() {
  const user = await requireUser(rolesFor("cameras.view"));
  const stores = await listStoresForUser(user);
  return (
    <>
      <PageHeader title="Stores" description="Centralised inventory of locations. Cameras and user access are organised by store." />
      <StoresTable stores={stores.map((s) => ({ ...s, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString() }))} canManage={can(user, "stores.manage")} />
    </>
  );
}
