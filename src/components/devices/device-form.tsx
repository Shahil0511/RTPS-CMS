"use client";

import { useActionState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { DeviceKind } from "@/db/schema";
import { createDeviceAction, updateDeviceAction } from "@/server/actions/devices";
import { idle } from "@/server/action-utils";

export interface DeviceFormValues {
  id?: string;
  storeId?: string;
  name?: string;
  kind?: DeviceKind;
  vendor?: string;
  host?: string;
  rtspPort?: number;
  httpPort?: number;
  httpsEnabled?: boolean;
  username?: string | null;
  hasPassword?: boolean;
  channelCount?: number | null;
  notes?: string | null;
  isEnabled?: boolean;
  timeMode?: string;
  utcOffsetMinutes?: number | null;
}

export function DeviceForm({
  initial,
  stores,
  onDone,
  onCancel,
}: {
  initial?: DeviceFormValues;
  stores: Array<{ id: string; name: string; code: string }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial?.id);
  const [state, action, pending] = useActionState(editing ? updateDeviceAction : createDeviceAction, idle);
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
        <Field label="Site" htmlFor="device-storeId" error={state.fieldErrors?.storeId}>
          <Select id="device-storeId" name="storeId" defaultValue={initial?.storeId ?? stores[0]?.id ?? ""} required>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Recorder name" htmlFor="device-name" error={state.fieldErrors?.name}>
          <Input id="device-name" name="name" defaultValue={initial?.name ?? ""} required placeholder="NVR 172.16.1.4" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="device-kind" error={state.fieldErrors?.kind}>
          <Select id="device-kind" name="kind" defaultValue={initial?.kind ?? "NVR"}>
            <option value="NVR">NVR (network video recorder)</option>
            <option value="DVR">DVR (digital video recorder)</option>
            <option value="CAMERA">Standalone camera</option>
          </Select>
        </Field>
        <Field label="Vendor" htmlFor="device-vendor" error={state.fieldErrors?.vendor} hint="Hikvision enables channel URLs and recorder playback (ISAPI)">
          <Select id="device-vendor" name="vendor" defaultValue={initial?.vendor ?? "hikvision"}>
            <option value="hikvision">Hikvision</option>
            <option value="generic">Generic / other</option>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_120px_120px]">
        <Field label="Host / IP" htmlFor="device-host" error={state.fieldErrors?.host}>
          <Input id="device-host" name="host" defaultValue={initial?.host ?? ""} required placeholder="172.16.1.4" className="font-mono" />
        </Field>
        <Field label="RTSP port" htmlFor="device-rtspPort" error={state.fieldErrors?.rtspPort}>
          <Input id="device-rtspPort" name="rtspPort" type="number" min={1} max={65535} defaultValue={initial?.rtspPort ?? 554} required />
        </Field>
        <Field label="HTTP port" htmlFor="device-httpPort" error={state.fieldErrors?.httpPort}>
          <Input id="device-httpPort" name="httpPort" type="number" min={1} max={65535} defaultValue={initial?.httpPort ?? 80} required />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Username" htmlFor="device-username" error={state.fieldErrors?.username}>
          <Input id="device-username" name="username" defaultValue={initial?.username ?? ""} autoComplete="off" placeholder="admin" />
        </Field>
        <Field label="Password" htmlFor="device-password" error={state.fieldErrors?.password} hint={editing && initial?.hasPassword ? "Leave blank to keep the stored password" : "Stored encrypted; shared by every linked channel"}>
          <Input id="device-password" name="password" type="password" defaultValue="" autoComplete="new-password" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <Field label="Channels" htmlFor="device-channelCount" error={state.fieldErrors?.channelCount} hint="Optional, 1-512">
          <Input id="device-channelCount" name="channelCount" type="number" min={1} max={512} defaultValue={initial?.channelCount ?? ""} placeholder="16" />
        </Field>
        <Field label="Notes" htmlFor="device-notes" error={state.fieldErrors?.notes}>
          <Textarea id="device-notes" name="notes" rows={2} defaultValue={initial?.notes ?? ""} placeholder="Rack location, HDD size, service contact…" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Recorder clock" htmlFor="device-timeMode" error={state.fieldErrors?.timeMode} hint="Most Hikvision NVRs report local time. Switch to UTC if playback starts at the wrong hour.">
          <Select id="device-timeMode" name="timeMode" defaultValue={initial?.timeMode ?? "local"}>
            <option value="local">Local time (recommended)</option>
            <option value="utc">UTC</option>
          </Select>
        </Field>
        <Field label="UTC offset (minutes)" htmlFor="device-utcOffset" error={state.fieldErrors?.utcOffsetMinutes} hint="Leave blank to read it from the recorder (IST = 330).">
          <Input id="device-utcOffset" name="utcOffsetMinutes" type="number" min={-720} max={840} defaultValue={initial?.utcOffsetMinutes ?? ""} placeholder="auto" />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Checkbox name="httpsEnabled" label="Use HTTPS for the web API" description="Tick when the recorder's HTTP port serves TLS." defaultChecked={initial?.httpsEnabled ?? false} />
        <Checkbox name="isEnabled" label="Enabled" description="Disabled recorders stop every linked channel." defaultChecked={initial?.isEnabled ?? true} />
      </div>

      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {editing ? "Save changes" : "Add recorder"}
        </Button>
      </DialogFooter>
    </form>
  );
}
