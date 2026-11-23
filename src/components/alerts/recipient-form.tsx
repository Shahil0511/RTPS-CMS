"use client";

import { useActionState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { createRecipientAction, updateRecipientAction } from "@/server/actions/alerts";
import { idle } from "@/server/action-utils";

export interface RecipientFormValues {
  id?: string;
  name?: string | null;
  email?: string;
  storeId?: string | null;
  onOffline?: boolean;
  onOnline?: boolean;
  dailyReport?: boolean;
  isActive?: boolean;
}

export interface StoreOption {
  id: string;
  name: string;
  code: string;
}

export function RecipientForm({
  initial,
  stores,
  onDone,
  onCancel,
}: {
  initial?: RecipientFormValues;
  stores: StoreOption[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial?.id);
  const [state, action, pending] = useActionState(editing ? updateRecipientAction : createRecipientAction, idle);
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="r-name" error={state.fieldErrors?.name} hint="Optional, e.g. “IT helpdesk” or the store manager">
          <Input id="r-name" name="name" defaultValue={initial?.name ?? ""} autoComplete="off" />
        </Field>
        <Field label="Email" htmlFor="r-email" error={state.fieldErrors?.email}>
          <Input id="r-email" name="email" type="email" defaultValue={initial?.email ?? ""} required autoComplete="off" autoFocus={!editing} />
        </Field>
      </div>
      <Field label="Location" htmlFor="r-store" error={state.fieldErrors?.storeId} hint="“All locations” receives alerts for every store, warehouse and office.">
        <Select id="r-store" name="storeId" defaultValue={initial?.storeId ?? ""}>
          <option value="">All locations</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.code})
            </option>
          ))}
        </Select>
      </Field>

      <fieldset className="rounded-[6px] border border-border p-3">
        <legend className="px-1 text-[13px] font-medium text-muted">Send me</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Checkbox name="onOffline" label="Offline alerts" description="Camera or recorder goes down" defaultChecked={initial?.onOffline ?? true} />
          <Checkbox name="onOnline" label="Back-online notices" description="With total downtime" defaultChecked={initial?.onOnline ?? true} />
          <Checkbox name="dailyReport" label="Daily health report" description="Previous day's summary" defaultChecked={initial?.dailyReport ?? true} />
        </div>
      </fieldset>
      <Checkbox name="isActive" label="Active" description="Paused recipients keep their settings but receive nothing." defaultChecked={initial?.isActive ?? true} />

      {state.error ? <p className="text-sm text-danger fade-in">{state.error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {editing ? "Save changes" : "Add recipient"}
        </Button>
      </DialogFooter>
    </form>
  );
}
