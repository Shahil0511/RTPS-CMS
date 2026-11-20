"use client";

import { ChevronDown } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/format";
import { createCameraAction, updateCameraAction } from "@/server/actions/cameras";
import { idle } from "@/server/action-utils";

export interface CameraFormValues {
  id?: string;
  storeId?: string;
  name?: string;
  description?: string | null;
  deviceId?: string | null;
  channel?: number | null;
  host?: string | null;
  port?: number;
  username?: string | null;
  hasPassword?: boolean;
  rtspPath?: string;
  transport?: "tcp" | "udp" | "automatic";
  recordEnabled?: boolean;
  retentionDays?: number;
  isEnabled?: boolean;
  sortOrder?: number;
}

export interface DeviceOptionData {
  id: string;
  name: string;
  host: string;
  storeId: string;
  kind: "NVR" | "DVR" | "CAMERA";
}

type SourceMode = "device" | "direct";

const DEFAULT_CHANNEL_PATH = (channel: number) => `/Streaming/Unicast/channels/${channel}01`;

export function CameraForm({
  initial,
  stores,
  devices,
  defaults,
  onDone,
  onCancel,
}: {
  initial?: CameraFormValues;
  stores: Array<{ id: string; name: string; code: string }>;
  devices: DeviceOptionData[];
  defaults: { recordEnabled: boolean; retentionDays: number };
  onDone: () => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial?.id);
  const [state, action, pending] = useActionState(editing ? updateCameraAction : createCameraAction, idle);
  const toast = useToast();
  const [storeId, setStoreId] = useState(initial?.storeId ?? stores[0]?.id ?? "");
  const siteDevices = devices.filter((d) => d.storeId === storeId);
  const [mode, setMode] = useState<SourceMode>(initial?.deviceId ? "device" : editing ? "direct" : devices.length > 0 ? "device" : "direct");
  const [deviceId, setDeviceId] = useState(initial?.deviceId ?? "");
  const [channel, setChannel] = useState<string>(initial?.channel ? String(initial.channel) : "");
  const [advanced, setAdvanced] = useState(Boolean(initial?.deviceId && initial.rtspPath && initial.channel && initial.rtspPath !== DEFAULT_CHANNEL_PATH(initial.channel)));
  const [pasteUrl, setPasteUrl] = useState("");
  const [parsed, setParsed] = useState<{ host: string; port: number; username: string; password: string; path: string } | null>(null);

  useEffect(() => {
    if (state.ok) {
      toast.success(state.message ?? "Saved");
      onDone();
    }
  }, [state, toast, onDone]);

  // Keep the recorder select consistent with the chosen site.
  useEffect(() => {
    if (deviceId && !siteDevices.some((d) => d.id === deviceId)) setDeviceId(siteDevices[0]?.id ?? "");
    else if (!deviceId && siteDevices[0]) setDeviceId(siteDevices[0].id);
  }, [storeId, deviceId, siteDevices]);

  // Convenience: paste a full rtsp:// URL and split it into fields (handles "@" inside passwords).
  const applyUrl = () => {
    const m = /^rtsps?:\/\/(.*)$/i.exec(pasteUrl.trim());
    if (!m) {
      toast.error("Paste a URL starting with rtsp://");
      return;
    }
    const rest = m[1] ?? "";
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "/" : rest.slice(slash);
    const at = authority.lastIndexOf("@");
    let username = "";
    let password = "";
    let hostPort = authority;
    if (at !== -1) {
      const cred = authority.slice(0, at);
      hostPort = authority.slice(at + 1);
      const c = cred.indexOf(":");
      username = decodeURIComponent(c === -1 ? cred : cred.slice(0, c));
      password = c === -1 ? "" : decodeURIComponent(cred.slice(c + 1));
    }
    const [host, portStr] = hostPort.split(":");
    setParsed({ host: host ?? "", port: Number(portStr) || 554, username, password, path });
    toast.info("URL parsed", "Fields were filled from the pasted URL.");
  };

  const v = {
    host: parsed?.host ?? initial?.host ?? "",
    port: parsed?.port ?? initial?.port ?? 554,
    username: parsed?.username ?? initial?.username ?? "",
    password: parsed?.password ?? "",
    rtspPath: parsed?.path ?? initial?.rtspPath ?? "/Streaming/Unicast/channels/101",
  };
  const channelNumber = Number(channel);
  const derivedPath = Number.isInteger(channelNumber) && channelNumber > 0 ? DEFAULT_CHANNEL_PATH(channelNumber) : "";
  const overridePath = initial?.deviceId && initial.rtspPath && initial.rtspPath !== derivedPath ? initial.rtspPath : "";

  return (
    <form action={action} className="space-y-4" noValidate>
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Store" htmlFor="storeId" error={state.fieldErrors?.storeId}>
          <Select id="storeId" name="storeId" value={storeId} onChange={(e) => setStoreId(e.target.value)} required>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Camera name" htmlFor="name" error={state.fieldErrors?.name} hint="Also used for the stream path, e.g. Table 1">
          <Input id="name" name="name" defaultValue={initial?.name ?? ""} required placeholder="Table 1" />
        </Field>
      </div>

      <div>
        <p className="mb-1.5 text-[13px] font-medium text-muted">Source</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <SourceOption active={mode === "device"} onClick={() => setMode("device")} title="Recorder channel" description="Channel of an NVR/DVR. Address and credentials come from the recorder." />
          <SourceOption active={mode === "direct"} onClick={() => setMode("direct")} title="Direct RTSP" description="Standalone camera or custom URL with its own credentials." />
        </div>
      </div>

      {mode === "device" ? (
        <div className="space-y-4 rounded-lg border border-border bg-surface-2/60 p-3">
          {siteDevices.length === 0 ? (
            <p className="text-sm text-warning">No recorder exists in this site yet. Add one under Recorders, or switch to a direct RTSP source.</p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <Field label="Recorder" htmlFor="deviceId" error={state.fieldErrors?.deviceId}>
              <Select id="deviceId" name="deviceId" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={siteDevices.length === 0} required>
                {siteDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.host} ({d.kind})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Channel" htmlFor="channel" error={state.fieldErrors?.channel} hint="1-512">
              <Input id="channel" name="channel" type="number" min={1} max={512} value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="1" required />
            </Field>
          </div>
          <div>
            <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-text">
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-180")} /> Advanced
            </button>
            {advanced ? (
              <Field label="Stream path override" htmlFor="rtspPath-device" error={state.fieldErrors?.rtspPath} hint={`Leave blank to use ${derivedPath || "/Streaming/Unicast/channels/<channel>01"} (main stream); use …02 for the sub-stream.`} className="mt-2">
                <Input id="rtspPath-device" name="rtspPath" defaultValue={overridePath} placeholder={derivedPath || "/Streaming/Unicast/channels/101"} className="font-mono" />
              </Field>
            ) : (
              <p className="mt-1 font-mono text-[12px] text-faint">{derivedPath || "/Streaming/Unicast/channels/<channel>01"}</p>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-border bg-surface-2/60 p-3">
          {!editing ? (
            <div className="rounded-lg border border-dashed border-border-strong bg-surface p-3">
              <p className="mb-2 text-[12px] font-medium text-muted">Quick fill from RTSP URL (optional)</p>
              <div className="flex gap-2">
                <Input value={pasteUrl} onChange={(e) => setPasteUrl(e.target.value)} placeholder="rtsp://admin:password@192.168.1.10:554/Streaming/Unicast/channels/101" className="font-mono text-[12.5px]" />
                <Button variant="secondary" onClick={applyUrl}>
                  Parse
                </Button>
              </div>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <Field label="Host / IP" htmlFor="host" error={state.fieldErrors?.host} hint="Camera address">
              <Input key={`host-${v.host}`} id="host" name="host" defaultValue={v.host} required placeholder="172.16.1.4" className="font-mono" />
            </Field>
            <Field label="RTSP port" htmlFor="port" error={state.fieldErrors?.port}>
              <Input key={`port-${v.port}`} id="port" name="port" type="number" min={1} max={65535} defaultValue={v.port} required />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username" htmlFor="username" error={state.fieldErrors?.username}>
              <Input key={`user-${v.username}`} id="username" name="username" defaultValue={v.username} autoComplete="off" placeholder="admin" />
            </Field>
            <Field label="Password" htmlFor="password" error={state.fieldErrors?.password} hint={editing && initial?.hasPassword && !initial.deviceId ? "Leave blank to keep the stored password" : "Stored encrypted"}>
              <Input key={`pass-${v.password}`} id="password" name="password" type="password" defaultValue={v.password} autoComplete="new-password" />
            </Field>
          </div>

          <Field label="Stream path" htmlFor="rtspPath" error={state.fieldErrors?.rtspPath} hint="Hikvision: /Streaming/Unicast/channels/<channel>01 (main) or 02 (sub)">
            <Input key={`path-${v.rtspPath}`} id="rtspPath" name="rtspPath" defaultValue={v.rtspPath} className="font-mono" />
          </Field>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Transport" htmlFor="transport">
          <Select id="transport" name="transport" defaultValue={initial?.transport ?? "tcp"}>
            <option value="tcp">TCP (recommended)</option>
            <option value="udp">UDP</option>
            <option value="automatic">Automatic</option>
          </Select>
        </Field>
        <Field label="Sort order" htmlFor="sortOrder">
          <Input id="sortOrder" name="sortOrder" type="number" min={0} defaultValue={initial?.sortOrder ?? 0} />
        </Field>
      </div>

      <Field label="Description" htmlFor="description">
        <Textarea id="description" name="description" rows={2} defaultValue={initial?.description ?? ""} placeholder="Location notes, field of view…" />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <p className="flex items-start gap-2 rounded-[4px] bg-surface-2 px-3 py-2 text-[12px] text-muted">
          Footage is recorded and kept on the recorder&apos;s own disks. Nothing is stored on this server.
        </p>
        <Checkbox name="isEnabled" label="Enabled" description="Disabled cameras are not pulled from the device." defaultChecked={initial?.isEnabled ?? true} />
      </div>

      {state.error ? <p className="text-sm text-danger">{state.error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" loading={pending}>
          {editing ? "Save changes" : "Add camera"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function SourceOption({ active, onClick, title, description }: { active: boolean; onClick: () => void; title: string; description: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-lg border p-3 text-left transition-colors",
        active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:border-border-strong",
      )}
    >
      <span className={cn("block text-sm font-medium", active ? "text-accent" : "text-text")}>{title}</span>
      <span className="block text-xs text-faint">{description}</span>
    </button>
  );
}
