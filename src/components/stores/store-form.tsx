"use client";

import { useActionState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import type { SiteKind } from "@/db/schema";
import { useToast } from "@/components/ui/toast";
import { createStoreAction, updateStoreAction } from "@/server/actions/stores";
import { idle } from "@/server/action-utils";

export interface StoreFormValues {
  id?: string;
  code?: string;
  name?: string;
  kind?: SiteKind;
  address?: string | null;
  city?: string | null;
  region?: string | null;
  phone?: string | null;
  timezone?: string;
  notes?: string | null;
  isActive?: boolean;
}

export function StoreForm({ initial, onDone, onCancel }: { initial?: StoreFormValues; onDone: () => void; onCancel: () => void }) {
  const editing = Boolean(initial?.id);
  const [state, action, pending] = useActionState(editing ? updateStoreAction : createStoreAction, idle);
  const toast = useToast();

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Saved");
      onDone();
    }
  }, [state, toast, onDone]);

  return (
    <form action={action} className="space-y-4" noValidate>
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
        <Field label="Code" htmlFor="code" error={state.fieldErrors?.code} hint="Short unique ID, e.g. HO or BLR01">
          <Input id="code" name="code" defaultValue={initial?.code ?? ""} required maxLength={12} className="uppercase" placeholder="HO" />
        </Field>
        <Field label="Site name" htmlFor="name" error={state.fieldErrors?.name}>
          <Input id="name" name="name" defaultValue={initial?.name ?? ""} required placeholder="Libas Head Office" />
        </Field>
      </div>
      <Field label="Site type" htmlFor="kind" error={state.fieldErrors?.kind} hint="Stores appear under the Stores tab in Live View; corporate offices and warehouses under the Corporate tab.">
        <Select id="kind" name="kind" defaultValue={initial?.kind ?? "STORE"}>
          <option value="STORE">Store</option>
          <option value="CORPORATE">Corporate office</option>
          <option value="WAREHOUSE">Warehouse</option>
        </Select>
      </Field>
      <Field label="Address" htmlFor="address" error={state.fieldErrors?.address}>
        <Input id="address" name="address" defaultValue={initial?.address ?? ""} placeholder="Street, area" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City" htmlFor="city">
          <Input id="city" name="city" defaultValue={initial?.city ?? ""} />
        </Field>
        <Field label="Region / State" htmlFor="region">
          <Input id="region" name="region" defaultValue={initial?.region ?? ""} />
        </Field>
        <Field label="Phone" htmlFor="phone">
          <Input id="phone" name="phone" defaultValue={initial?.phone ?? ""} />
        </Field>
      </div>
      <Field label="Timezone" htmlFor="timezone" error={state.fieldErrors?.timezone} hint="IANA name used for store-local times">
        <Input id="timezone" name="timezone" defaultValue={initial?.timezone ?? "Asia/Kolkata"} required />
      </Field>
      <Field label="Notes" htmlFor="notes">
        <Textarea id="notes" name="notes" defaultValue={initial?.notes ?? ""} rows={3} />
      </Field>
      <Checkbox name="isActive" label="Active" description="Inactive stores are hidden from live view selectors." defaultChecked={initial?.isActive ?? true} />
      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {editing ? "Save changes" : "Create store"}
        </Button>
      </DialogFooter>
    </form>
  );
}
