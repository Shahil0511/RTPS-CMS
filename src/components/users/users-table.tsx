"use client";

import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, RoleBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { Role } from "@/db/schema";
import { formatDateTime, formatRelative } from "@/lib/format";
import { deleteUserAction } from "@/server/actions/users";
import { UserForm } from "./user-form";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  stores: Array<{ id: string; name: string; code: string }>;
}

export function UsersTable({ users, stores, currentUserId }: { users: UserRow[]; stores: Array<{ id: string; name: string; code: string; isActive: boolean }>; currentUserId: string }) {
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  const router = useRouter();
  const close = () => setEditing(null);
  const done = () => {
    close();
    router.refresh();
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] text-muted">{users.length} user{users.length === 1 ? "" : "s"}</span>
        <Button onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </div>
      <Card className="overflow-hidden">
        {users.length === 0 ? (
          <EmptyState icon={<Users className="h-5 w-5" />} title="No users" className="m-4" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>User</TH>
                <TH>Role</TH>
                <TH>Store access</TH>
                <TH>Status</TH>
                <TH>Last sign-in</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {users.map((u) => (
                <TR key={u.id}>
                  <TD>
                    <p className="font-medium text-text">
                      {u.name} {u.id === currentUserId ? <span className="text-[11px] text-faint">(you)</span> : null}
                    </p>
                    <p className="text-[12px] text-muted">{u.email}</p>
                  </TD>
                  <TD>
                    <RoleBadge role={u.role} />
                  </TD>
                  <TD className="max-w-[320px]">
                    {u.role === "ADMIN" ? (
                      <span className="text-[13px] text-muted">All stores</span>
                    ) : u.stores.length === 0 ? (
                      <span className="text-[13px] text-danger">None assigned</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {u.stores.slice(0, 4).map((s) => (
                          <Badge key={s.id}>{s.code}</Badge>
                        ))}
                        {u.stores.length > 4 ? <Badge>+{u.stores.length - 4}</Badge> : null}
                      </div>
                    )}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {u.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}
                      {u.mustChangePassword ? <Badge tone="warning">Password reset pending</Badge> : null}
                    </div>
                  </TD>
                  <TD className="text-[13px] text-muted" title={u.lastLoginAt ? formatDateTime(u.lastLoginAt) : ""}>
                    {formatRelative(u.lastLoginAt)}
                  </TD>
                  <TD className="text-right">
                    <div className="inline-flex gap-1">
                      <Button variant="ghost" size="icon" aria-label="Edit user" onClick={() => setEditing(u)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <ConfirmButton
                        variant="ghost"
                        size="icon"
                        aria-label="Delete user"
                        title={`Delete ${u.name}?`}
                        description="The account is removed permanently. Audit history is kept."
                        confirmLabel="Delete"
                        action={() => deleteUserAction(u.id)}
                        onDone={(s) => s.ok && router.refresh()}
                        disabled={u.id === currentUserId}
                      >
                        <Trash2 className="h-4 w-4 text-danger" />
                      </ConfirmButton>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog open={editing !== null} onClose={close} title={editing === "new" ? "Add user" : `Edit ${editing?.name ?? ""}`} size="lg">
        <UserForm initial={editing && editing !== "new" ? editing : undefined} stores={stores} isSelf={editing !== "new" && editing?.id === currentUserId} onDone={done} onCancel={close} />
      </Dialog>
    </>
  );
}
