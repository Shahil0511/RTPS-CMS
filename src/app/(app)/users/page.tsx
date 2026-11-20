import type { Metadata } from "next";
import { UsersTable } from "@/components/users/users-table";
import { PageHeader } from "@/components/ui/page-header";
import { rolesFor } from "@/lib/auth/rbac";
import { requireUser } from "@/lib/auth/session";
import { listAllStores } from "@/server/queries/stores";
import { listUsers } from "@/server/queries/users";

export const metadata: Metadata = { title: "Users & roles" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireUser(rolesFor("users.manage"));
  const [users, stores] = await Promise.all([listUsers(), listAllStores()]);
  return (
    <>
      <PageHeader title="Users & roles" description="Administrators see everything; managers and viewers are restricted to their assigned stores." />
      <UsersTable
        currentUserId={me.id}
        stores={stores}
        users={users.map((u) => ({ ...u, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() }))}
      />
    </>
  );
}
