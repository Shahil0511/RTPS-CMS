import type { Metadata } from "next";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { RoleBadge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth/session";
import { ROLE_DESCRIPTIONS } from "@/lib/auth/rbac";
import { listStoresForUser } from "@/server/queries/stores";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "My account" };
export const dynamic = "force-dynamic";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const user = await requireUser();
  const { reason } = await searchParams;
  const stores = await listStoresForUser(user);

  return (
    <>
      <PageHeader title="My account" description="Your access and credentials." />
      {reason === "change-password" || user.mustChangePassword ? (
        <p className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
          Your password must be changed before you can use the system.
        </p>
      ) : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4"><dt className="text-muted">Name</dt><dd className="font-medium">{user.name}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Email</dt><dd className="font-medium">{user.email}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted">Role</dt><dd><RoleBadge role={user.role} /></dd></div>
            </dl>
            <p className="mt-3 text-[13px] text-faint">{ROLE_DESCRIPTIONS[user.role]}</p>
            <div className="mt-4">
              <p className="text-[12px] font-medium uppercase tracking-wide text-faint">Store access</p>
              {user.isAdmin ? (
                <p className="mt-1 text-sm text-muted">All stores (administrator)</p>
              ) : stores.length === 0 ? (
                <p className="mt-1 text-sm text-danger">No stores assigned. Ask an administrator.</p>
              ) : (
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {stores.map((s) => (
                    <li key={s.id} className="rounded-md bg-surface-2 px-2 py-1 text-[12px] text-text">{s.name}</li>
                  ))}
                </ul>
              )}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Change password" description="At least 10 characters with upper and lower case letters and a number." />
          <CardBody>
            <ChangePasswordForm />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
