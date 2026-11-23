"use client";

import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { ConnectionMode, DeviceKind } from "@/db/schema";
import { cn } from "@/lib/format";
import {
  CLOUD_PLATFORMS,
  CONNECTION_MODE_LABELS,
  DEVICE_VENDOR_OPTIONS,
  hostOptionalFor,
  protocolFamilyOf,
  RTSP_TEMPLATE_PLACEHOLDERS,
  rtspTemplateFromNotes,
  stripRtspTemplate,
  VENDORS,
  vendorOf,
  type CapabilityLevel,
} from "@/lib/vendors";
import { createDeviceAction, updateDeviceAction } from "@/server/actions/devices";
import { idle } from "@/server/action-utils";

export interface DeviceFormValues {
  id?: string;
  storeId?: string;
  name?: string;
  kind?: DeviceKind;
  vendor?: string;
  /** Omitted on edit = the form leaves the stored connection mode unchanged. */
  connectionMode?: ConnectionMode;
  /** Omitted (undefined) on edit = the cloud fields are not shown and the stored values are kept. */
  cloudPlatform?: string | null;
  cloudAccount?: string | null;
  host?: string;
  rtspPort?: number;
  httpPort?: number;
  httpsEnabled?: boolean;
  username?: string | null;
  hasPassword?: boolean;
  channelCount?: number | null;
  /** Stored notes, including the "RTSP template:" marker line for template-family vendors. */
  notes?: string | null;
  isEnabled?: boolean;
  timeMode?: string;
  utcOffsetMinutes?: number | null;
}

const MODE_ORDER: ConnectionMode[] = ["DIRECT", "RELAY", "PENDING_NETWORK", "CLOUD_ONLY"];

const MODE_HINTS: Record<ConnectionMode, string> = {
  DIRECT: "Monitored, streamed and alerted on.",
  RELAY: "Monitored through a relay or tunnel address.",
  PENDING_NETWORK: "Listed only. No checks, no alerts. Address optional.",
  CLOUD_ONLY: "Listed only. No checks, no alerts. Address optional.",
};

const CAPABILITY_TONE: Record<CapabilityLevel, string> = {
  verified: "bg-success-soft text-success",
  supported: "bg-info-soft text-info",
  unverified: "bg-warning-soft text-warning",
  unsupported: "bg-surface-hover text-faint",
};

function CapabilityChips({ vendor }: { vendor: string }) {
  const info = VENDORS[vendorOf(vendor)];
  const items: Array<[string, CapabilityLevel]> = [
    ["Live", info.live],
    ["Playback", info.playback],
    ["Download", info.download],
    ["Health", info.health],
  ];
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {items.map(([label, level]) => (
        <span key={label} title={`${label}: ${level}`} className={cn("rounded-[3px] px-1.5 py-px text-[11px] font-semibold", CAPABILITY_TONE[level])}>
          {label} {level === "verified" ? "verified" : level === "unsupported" ? "n/a" : level}
        </span>
      ))}
    </div>
  );
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

  const initialVendor = initial?.vendor ?? "hikvision";
  const [vendor, setVendor] = useState(initialVendor);
  // On edit without a known mode no option is checked, the field is not submitted and the server keeps the stored mode.
  const [mode, setMode] = useState<ConnectionMode | "">(initial?.connectionMode ?? (editing ? "" : "DIRECT"));

  const family = protocolFamilyOf(vendor);
  const vendorOption = DEVICE_VENDOR_OPTIONS.find((o) => o.value === vendor);
  const legacyVendor = !DEVICE_VENDOR_OPTIONS.some((o) => o.value === initialVendor);
  const hostOptional = mode === "" ? !initial?.host : hostOptionalFor(mode);
  const cloudKnown = !editing || initial?.cloudPlatform !== undefined || initial?.cloudAccount !== undefined;
  const initialTemplate = rtspTemplateFromNotes(initial?.notes) ?? "";

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
        <div>
          <Field label="Vendor" htmlFor="device-vendor" error={state.fieldErrors?.vendor} hint={vendorOption?.hint}>
            <Select id="device-vendor" name="vendor" value={vendor} onChange={(e) => setVendor(e.target.value)}>
              {DEVICE_VENDOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {legacyVendor ? (
                <option value={initialVendor} disabled>
                  {initialVendor} (not supported, pick a vendor)
                </option>
              ) : null}
            </Select>
          </Field>
          <CapabilityChips vendor={vendor} />
        </div>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-text">Connection</legend>
        <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
          {MODE_ORDER.map((m) => {
            const info = CONNECTION_MODE_LABELS[m];
            const checked = mode === m;
            return (
              <label
                key={m}
                title={info.description}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-[var(--radius)] border px-3 py-2 transition-colors duration-150",
                  checked ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong hover:bg-surface-hover",
                )}
              >
                <input type="radio" name="connectionMode" value={m} checked={checked} onChange={() => setMode(m)} className="mt-0.5 h-4 w-4 accent-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{info.label}</span>
                  <span className="block text-xs text-faint">{MODE_HINTS[m]}</span>
                </span>
              </label>
            );
          })}
        </div>
        {state.fieldErrors?.connectionMode?.[0] ? (
          <p className="mt-1 text-xs text-danger">{state.fieldErrors.connectionMode[0]}</p>
        ) : (
          <p className="mt-1 text-xs text-faint">{mode ? CONNECTION_MODE_LABELS[mode].description : "Current connection setting is kept unless you pick one."}</p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-[1fr_120px_120px]">
        <Field
          label={hostOptional ? "Host / IP (optional)" : "Host / IP"}
          htmlFor="device-host"
          error={state.fieldErrors?.host}
          hint={hostOptional ? "Leave blank if the address is not known yet." : undefined}
        >
          <Input id="device-host" name="host" defaultValue={initial?.host ?? ""} required={!hostOptional} placeholder="172.16.1.4" className="font-mono" />
        </Field>
        <Field label="RTSP port" htmlFor="device-rtspPort" error={state.fieldErrors?.rtspPort}>
          <Input id="device-rtspPort" name="rtspPort" type="number" min={1} max={65535} defaultValue={initial?.rtspPort ?? 554} required />
        </Field>
        <Field label="HTTP port" htmlFor="device-httpPort" error={state.fieldErrors?.httpPort}>
          <Input id="device-httpPort" name="httpPort" type="number" min={1} max={65535} defaultValue={initial?.httpPort ?? 80} required />
        </Field>
      </div>

      {family === "template" ? (
        <Field
          label="RTSP path template"
          htmlFor="device-rtspTemplate"
          error={state.fieldErrors?.rtspTemplate}
          hint={`Path only (no host or credentials). Placeholders: ${RTSP_TEMPLATE_PLACEHOLDERS.join(", ")}. Example: /stream{stream}/ch{channel}. Blank = Hikvision-style path.`}
        >
          <Input id="device-rtspTemplate" name="rtspTemplate" defaultValue={initialTemplate} placeholder="/cam/realmonitor?channel={channel}&subtype={stream}" className="font-mono" autoComplete="off" />
        </Field>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Username" htmlFor="device-username" error={state.fieldErrors?.username}>
          <Input id="device-username" name="username" defaultValue={initial?.username ?? ""} autoComplete="off" placeholder="admin" />
        </Field>
        <Field label="Password" htmlFor="device-password" error={state.fieldErrors?.password} hint={editing && initial?.hasPassword ? "Leave blank to keep the stored password" : "Stored encrypted; shared by every linked channel"}>
          <Input id="device-password" name="password" type="password" defaultValue="" autoComplete="new-password" />
        </Field>
      </div>

      {cloudKnown ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <input type="hidden" name="cloudFields" value="1" />
          <Field label="Vendor cloud (optional)" htmlFor="device-cloudPlatform" error={state.fieldErrors?.cloudPlatform} hint="App the store uses remotely, e.g. InstaOnCloud, Hik-Connect, IH View.">
            <Input id="device-cloudPlatform" name="cloudPlatform" list="device-cloud-platforms" defaultValue={initial?.cloudPlatform ?? ""} autoComplete="off" placeholder="Hik-Connect" />
            <datalist id="device-cloud-platforms">
              {CLOUD_PLATFORMS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <Field label="Cloud account / device ID" htmlFor="device-cloudAccount" error={state.fieldErrors?.cloudAccount} hint="Login name or serial on the cloud. Never a password.">
            <Input id="device-cloudAccount" name="cloudAccount" defaultValue={initial?.cloudAccount ?? ""} autoComplete="off" />
          </Field>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <Field label="Channels" htmlFor="device-channelCount" error={state.fieldErrors?.channelCount} hint="Optional, 1-512">
          <Input id="device-channelCount" name="channelCount" type="number" min={1} max={512} defaultValue={initial?.channelCount ?? ""} placeholder="16" />
        </Field>
        <Field label="Notes" htmlFor="device-notes" error={state.fieldErrors?.notes}>
          <Textarea id="device-notes" name="notes" rows={2} defaultValue={stripRtspTemplate(initial?.notes) ?? ""} placeholder="Rack location, HDD size, service contact…" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Recorder clock" htmlFor="device-timeMode" error={state.fieldErrors?.timeMode} hint="Most recorders report local time. Switch to UTC if playback starts at the wrong hour.">
          <Select id="device-timeMode" name="timeMode" defaultValue={initial?.timeMode ?? "local"}>
            <option value="local">Local time (recommended)</option>
            <option value="utc">UTC</option>
          </Select>
        </Field>
        <Field
          label="UTC offset (minutes)"
          htmlFor="device-utcOffset"
          error={state.fieldErrors?.utcOffsetMinutes}
          hint={family === "isapi" ? "Leave blank to read it from the recorder (IST = 330)." : "IST = 330. Only Hikvision-family recorders can report it automatically."}
        >
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
