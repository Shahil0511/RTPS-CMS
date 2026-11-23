"use client";

import { Camera, Download, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { Role } from "@/db/schema";
import { ROLE_LABELS } from "@/lib/auth/rbac";
import { formatDateTime, formatRelative } from "@/lib/format";
import { deleteUserAction } from "@/server/actions/users";
import type { AccessCamera, AccessStore } from "./access-picker";
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
  allowDownload: boolean | null;
  canDownload: boolean;
  limitedStoreIds: string[];
  cameraIds: string[];
  restrictedStoreCount: number;
}

const ROLE_TONE: Record<Role, "accent" | "info" | "neutral"> = { ADMIN: "accent", MANAGER: "info", VIEWER: "neutral" };

export function UsersTable({ users, stores, cameras, currentUserId }: { users: UserRow[]; stores: AccessStore[]; cameras: AccessCamera[]; currentUserId: string }) {
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  const [query, setQuery] = useState("");
  const router = useRouter();
  const close = () => setEditing(null);
  const done = () => {
    close();
    router.refresh();
  };

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      q
        ? users.filter(
            (u) =>
              u.name.toLowerCase().includes(q) ||
              u.email.toLowerCase().includes(q) ||
              ROLE_LABELS[u.role].toLowerCase().includes(q) ||
              u.stores.some((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)),
          )
        : users,
    [users, q],
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-64 max-w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search users, roles or locations" className="pl-8" aria-label="Search users" />
          </div>
          <span className="text-[13px] text-muted">
            {q ? `${shown.length} of ` : ""}
            {users.length} user{users.length === 1 ? "" : "s"}
          </span>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus className="h-4 w-4" /> Add user
        </Button>
      </div>
      <Card className="overflow-hidden">
        {shown.length === 0 ? (
          <EmptyState icon={<Users className="h-5 w-5" />} title={q ? "No matching users" : "No users"} className="m-4" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>User</TH>
                <TH>Role</TH>
                <TH>Locations</TH>
                <TH>Cameras</TH>
                <TH>Download</TH>
                <TH>Status</TH>
                <TH>Last sign-in</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {shown.map((u) => (
                <TR key={u.id}>
                  <TD>
                    <p className="font-medium text-text">
                      {u.name} {u.id === currentUserId ? <span className="text-[11px] text-faint">(you)</span> : null}
                    </p>
                    <p className="text-[12px] text-muted">{u.email}</p>
                  </TD>
                  <TD>
                    <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</Badge>
                  </TD>
                  <TD className="max-w-[280px]">
                    {u.role === "ADMIN" ? (
                      <span className="text-[13px] text-muted">All locations</span>
                    ) : u.stores.length === 0 ? (
                      <span className="text-[13px] text-danger">None assigned</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1" title={u.stores.map((s) => s.name).join(", ")}>
                        <span className="mr-1 text-[13px] tabular-nums text-text">{u.stores.length}</span>
                        {u.stores.slice(0, 3).map((s) => (
                          <Badge key={s.id}>{s.code}</Badge>
                        ))}
                        {u.stores.length > 3 ? <Badge>+{u.stores.length - 3}</Badge> : null}
                      </div>
                    )}
                  </TD>
                  <TD>
                    {u.role === "ADMIN" || u.restrictedStoreCount === 0 ? (
                      <span className="text-[13px] text-muted">All</span>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1.5 text-[13px] tabular-nums text-text"
                        title={`Limited to specific cameras in ${u.restrictedStoreCount} of ${u.stores.length} location${u.stores.length === 1 ? "" : "s"}; all cameras in the others.`}
                      >
                        <Camera className="h-3.5 w-3.5 text-faint" />
                        {u.cameraIds.length}
                        {u.restrictedStoreCount < u.stores.length ? <span className="text-[11px] text-faint">+ all in {u.stores.length - u.restrictedStoreCount}</span> : null}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <div className="flex items-center gap-1.5">
                      {u.canDownload ? (
                        <Badge tone="success">
                          <Download className="h-3 w-3" /> Allowed
                        </Badge>
                      ) : (
                        <Badge>Not allowed</Badge>
                      )}
                      {u.allowDownload !== null ? (
                        <span className="text-[11px] text-faint" title="Set on this user, overriding the role default">
                          override
                        </span>
                      ) : null}
                    </div>
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

      <Dialog
        open={editing !== null}
        onClose={close}
        title={editing === "new" ? "Add user" : `Edit ${editing?.name ?? ""}`}
        description="Choose the locations this person can see, optionally narrow each one to specific cameras, and decide whether they may download footage."
        size="lg"
      >
        <UserForm initial={editing && editing !== "new" ? editing : undefined} stores={stores} cameras={cameras} isSelf={editing !== "new" && editing?.id === currentUserId} onDone={done} onCancel={close} />
      </Dialog>
    </>
  );
}
