import type { Metadata } from "next";
import { UsersTable } from "@/components/users/users-table";
import { PageHeader } from "@/components/ui/page-header";
import { rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { listCameraOptions } from "@/server/queries/cameras";
import { listAllStores } from "@/server/queries/stores";
import { listUsers } from "@/server/queries/users";

export const metadata: Metadata = { title: "Users & roles" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  // Admin-only page: the camera option list covers every location.
  const me = await requireUser(rolesFor("users.manage"));
  const [users, stores, cameras] = await Promise.all([listUsers(), listAllStores(), listCameraOptions()]);
  return (
    <>
      <PageHeader
        title="Users & roles"
        description="Administrators see everything. Store managers and viewers only see their assigned locations, optionally narrowed to specific cameras, and download footage only when allowed."
      />
      <UsersTable
        currentUserId={me.id}
        stores={stores}
        cameras={cameras}
        users={users.map((u) => ({ ...u, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() }))}
      />
    </>
  );
}
