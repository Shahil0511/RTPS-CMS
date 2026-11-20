"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ROLES, type Role } from "@/db/schema";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/auth/rbac";
import { createUserAction, updateUserAction } from "@/server/actions/users";
import { idle } from "@/server/action-utils";

export interface UserFormValues {
  id?: string;
  email?: string;
  name?: string;
  role?: Role;
  isActive?: boolean;
  mustChangePassword?: boolean;
  stores?: Array<{ id: string }>;
}

export function UserForm({
  initial,
  stores,
  isSelf,
  onDone,
  onCancel,
}: {
  initial?: UserFormValues;
  stores: Array<{ id: string; name: string; code: string; isActive: boolean }>;
  isSelf: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial?.id);
  const [state, action, pending] = useActionState(editing ? updateUserAction : createUserAction, idle);
  const [role, setRole] = useState<Role>(initial?.role ?? "VIEWER");
  const toast = useToast();
  const assigned = new Set((initial?.stores ?? []).map((s) => s.id));

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Saved");
      onDone();
    }
  }, [state, toast, onDone]);

  return (
    <form action={action} className="space-y-4" noValidate>
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" htmlFor="name" error={state.fieldErrors?.name}>
          <Input id="name" name="name" defaultValue={initial?.name ?? ""} required />
        </Field>
        <Field label="Email" htmlFor="email" error={state.fieldErrors?.email} hint="Used to sign in">
          <Input id="email" name="email" type="email" defaultValue={initial?.email ?? ""} required autoComplete="off" />
        </Field>
      </div>
      <Field label={editing ? "New password" : "Password"} htmlFor="password" error={state.fieldErrors?.password} hint={editing ? "Leave blank to keep the current password. Setting one signs the user out everywhere." : "10+ characters with upper, lower case and a number"}>
        <Input id="password" name="password" type="password" autoComplete="new-password" />
      </Field>
      <Field label="Role" htmlFor="role" error={state.fieldErrors?.role} hint={ROLE_DESCRIPTIONS[role]}>
        <Select id="role" name="role" value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isSelf}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </Select>
        {isSelf ? <input type="hidden" name="role" value={role} /> : null}
      </Field>

      {role !== "ADMIN" ? (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">Store access</p>
          {stores.length === 0 ? (
            <p className="text-sm text-danger">No stores exist yet. Create a store before adding managers or viewers.</p>
          ) : (
            <div className="grid max-h-56 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
              {stores.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">
                  <input type="checkbox" name="storeIds[]" value={s.id} defaultChecked={assigned.has(s.id)} className="h-4 w-4 accent-[var(--accent)]" />
                  <span className="truncate">{s.name}</span>
                  <span className="ml-auto font-mono text-[11px] text-faint">{s.code}</span>
                </label>
              ))}
            </div>
          )}
          {state.fieldErrors?.storeIds ? <p className="mt-1 text-xs text-danger">{state.fieldErrors.storeIds[0]}</p> : null}
        </div>
      ) : (
        <p className="rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent">Administrators have access to every store.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Checkbox name="isActive" label="Active" description="Inactive users cannot sign in." defaultChecked={initial?.isActive ?? true} disabled={isSelf} />
        {isSelf ? <input type="hidden" name="isActive" value="on" /> : null}
        <Checkbox name="mustChangePassword" label="Require password change" description="User must set a new password at next sign-in." defaultChecked={initial?.mustChangePassword ?? !editing} />
      </div>

      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {editing ? "Save changes" : "Create user"}
        </Button>
      </DialogFooter>
    </form>
  );
}
