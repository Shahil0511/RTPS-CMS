"use client";

import { Download } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { ROLES, type Role } from "@/db/schema";
import { can, DOWNLOAD_OVERRIDE_LABELS, downloadOverrideOf, ROLE_DESCRIPTIONS, ROLE_LABELS, type DownloadOverride } from "@/lib/auth/rbac";
import { cn } from "@/lib/format";
import { createUserAction, updateUserAction } from "@/server/actions/users";
import { idle } from "@/server/action-utils";
import { AccessPicker, type AccessCamera, type AccessStore } from "./access-picker";

export interface UserFormValues {
  id?: string;
  email?: string;
  name?: string;
  role?: Role;
  isActive?: boolean;
  mustChangePassword?: boolean;
  stores?: Array<{ id: string }>;
  /** Assigned stores limited to specific cameras (user_stores.camera_limited). */
  limitedStoreIds?: string[];
  /** Camera-level grants (only inside camera-limited stores). */
  cameraIds?: string[];
  allowDownload?: boolean | null;
}

export function UserForm({
  initial,
  stores,
  cameras,
  isSelf,
  onDone,
  onCancel,
}: {
  initial?: UserFormValues;
  stores: AccessStore[];
  cameras: AccessCamera[];
  isSelf: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial?.id);
  const [state, action, pending] = useActionState(editing ? updateUserAction : createUserAction, idle);
  const [role, setRole] = useState<Role>(initial?.role ?? "VIEWER");
  const toast = useToast();

  // Computed once per dialog open (the dialog unmounts its body when closed).
  const [initialAccess] = useState(() => {
    const storeIds = new Set((initial?.stores ?? []).map((s) => s.id));
    const cameraIds = new Set(initial?.cameraIds ?? []);
    // The flag, not the grants, decides "specific cameras": a limited store may hold zero grants
    // (e.g. after its last granted camera was deleted) and must still open as limited.
    const limited = new Set((initial?.limitedStoreIds ?? []).filter((id) => storeIds.has(id)));
    return { storeIds, cameraIds, limited };
  });
  const [storeIds, setStoreIds] = useState(initialAccess.storeIds);
  const [limited, setLimited] = useState(initialAccess.limited);
  const [cameraIds, setCameraIds] = useState(initialAccess.cameraIds);
  const [download, setDownload] = useState<DownloadOverride>(downloadOverrideOf(initial?.allowDownload));

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Saved");
      onDone();
    }
  }, [state, toast, onDone]);

  const roleDefault = can({ role }, "playback.export");
  const effectiveDownload = download === "allow" ? true : download === "deny" ? false : roleDefault;

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
        <>
          <AccessPicker
            stores={stores}
            cameras={cameras}
            storeIds={storeIds}
            onStoreIdsChange={setStoreIds}
            limited={limited}
            onLimitedChange={setLimited}
            cameraIds={cameraIds}
            onCameraIdsChange={setCameraIds}
            error={state.fieldErrors?.storeIds?.[0]}
          />

          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-muted">
              <Download className="h-3.5 w-3.5" /> Can download footage
            </p>
            <input type="hidden" name="allowDownload" value={download} />
            <div className="flex flex-wrap items-center gap-3">
              <div role="radiogroup" aria-label="Can download footage" className="inline-flex overflow-hidden rounded-[4px] border border-border-strong/70 text-[13px] font-medium">
                {(Object.keys(DOWNLOAD_OVERRIDE_LABELS) as DownloadOverride[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={download === k}
                    onClick={() => setDownload(k)}
                    className={cn(
                      "border-r border-border-strong/40 px-3 py-1.5 transition-colors last:border-r-0",
                      download === k ? "bg-accent text-white" : "bg-surface text-muted hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    {DOWNLOAD_OVERRIDE_LABELS[k]}
                    {k === "default" ? <span className={cn("ml-1 text-[11px]", download === k ? "text-white/80" : "text-faint")}>({roleDefault ? "allowed" : "not allowed"})</span> : null}
                  </button>
                ))}
              </div>
              <span className={cn("text-[12px] transition-colors", effectiveDownload ? "text-success" : "text-faint")}>
                {effectiveDownload ? "This user can download recordings of the cameras they can see." : "This user can watch recordings but not download them."}
              </span>
            </div>
          </div>
        </>
      ) : (
        <p className="rounded-[4px] bg-accent-soft px-3 py-2 text-[13px] text-accent">Administrators see every location and camera and can always download footage.</p>
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
