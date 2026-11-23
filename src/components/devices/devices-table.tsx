"use client";

import { Camera, Cloud, HardDrive, MoreHorizontal, Pencil, Plug, Plus, Power, Search, Trash2, ListPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ConnectionBadge, DataQualityBadges } from "@/components/health/connection-badge";
import { dataQualityFlags, type LinkState } from "@/components/health/connection-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { CameraStatus, ConnectionMode, DeviceKind } from "@/db/schema";
import { cn, formatRelative } from "@/lib/format";
import { CONNECTION_MODE_LABELS, isIsapiVendor, VENDORS, vendorLabel, type VendorId } from "@/lib/vendors";
import { deleteDeviceAction, importDeviceChannelsAction, testDeviceAction, toggleDeviceEnabledAction } from "@/server/actions/devices";
import { DeviceForm, type DeviceFormValues } from "./device-form";

export interface DeviceRowData extends DeviceFormValues {
  id: string;
  storeId: string;
  storeName: string;
  storeCode: string;
  name: string;
  kind: DeviceKind;
  vendor: string;
  /** Vendor resolved from the stored value plus model/name hints (Tyco Holis vs Hikvision). */
  vendorId: VendorId;
  host: string;
  rtspPort: number;
  httpPort: number;
  httpsEnabled: boolean;
  model: string | null;
  /** Serial with everything but the last four characters masked (masked on the server). */
  serialMasked: string | null;
  firmware: string | null;
  connectionMode: ConnectionMode;
  cloudPlatform: string | null;
  cloudAccount: string | null;
  linkState: LinkState;
  storageStatus: string | null;
  storageTotalMb: number | null;
  storageFreeMb: number | null;
  isEnabled: boolean;
  status: CameraStatus;
  lastError: string | null;
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  cameraCount: number;
  onlineCameraCount: number;
}

type Modal = { kind: "new" } | { kind: "edit"; device: DeviceRowData } | { kind: "delete"; device: DeviceRowData } | null;

export function KindBadge({ kind }: { kind: DeviceKind }) {
  return <Badge tone={kind === "NVR" ? "accent" : kind === "DVR" ? "info" : "neutral"}>{kind === "CAMERA" ? "Camera" : kind}</Badge>;
}

export interface DeviceFacets {
  modes: Record<ConnectionMode, number>;
  vendors: Partial<Record<VendorId, number>>;
}

// Kept client-side (importing values from the Drizzle schema would pull it into the browser bundle).
const CONNECTION_MODES = Object.keys(CONNECTION_MODE_LABELS) as ConnectionMode[];
const MODE_SHORT: Record<ConnectionMode, string> = { DIRECT: "Direct", RELAY: "Relay", PENDING_NETWORK: "No route yet", CLOUD_ONLY: "Vendor cloud" };

export function DevicesTable({
  devices,
  total,
  stores,
  canManage,
  filter,
  facets,
}: {
  devices: DeviceRowData[];
  total: number;
  stores: Array<{ id: string; name: string; code: string }>;
  canManage: boolean;
  filter: { store: string; q: string; mode: string; vendor: string };
  facets: DeviceFacets;
}) {
  const [modal, setModal] = useState<Modal>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [unlink, setUnlink] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuFor(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuFor]);

  const close = () => {
    setModal(null);
    setUnlink(false);
  };
  const done = () => {
    close();
    router.refresh();
  };

  const applyFilter = (next: Partial<typeof filter>) => {
    const qs = new URLSearchParams();
    const f = { ...filter, ...next };
    if (f.store) qs.set("store", f.store);
    if (f.q) qs.set("q", f.q);
    if (f.mode) qs.set("mode", f.mode);
    if (f.vendor) qs.set("vendor", f.vendor);
    router.push(`/devices${qs.size ? `?${qs}` : ""}`);
  };

  const run = (label: string, fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      setMenuFor(null);
      const r = await fn();
      if (r.ok) toast.success(label, r.message);
      else toast.error(`${label} failed`, r.error ?? r.message);
      router.refresh();
    });

  const deleteDevice = (device: DeviceRowData) => {
    const fd = new FormData();
    if (unlink) fd.set("unlinkCameras", "on");
    return run("Recorder deleted", () => deleteDeviceAction(device.id, fd).then((r) => { close(); return r; }));
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={filter.store} onChange={(e) => applyFilter({ store: e.target.value })} className="w-auto min-w-48" aria-label="Site">
          <option value="">All sites</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyFilter({ q: String(new FormData(e.currentTarget).get("q") ?? "") });
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
          <Input name="q" defaultValue={filter.q} placeholder="Search name, host, model, serial" className="w-64 pl-8" />
        </form>
        <Select value={filter.mode} onChange={(e) => applyFilter({ mode: e.target.value })} className="w-auto min-w-44" aria-label="Connection mode">
          <option value="">All connection modes</option>
          {CONNECTION_MODES.map((m) => (
            <option key={m} value={m} disabled={!facets.modes[m] && filter.mode !== m}>
              {m === "DIRECT" ? "Direct" : CONNECTION_MODE_LABELS[m].label} ({facets.modes[m] ?? 0})
            </option>
          ))}
        </Select>
        <Select value={filter.vendor} onChange={(e) => applyFilter({ vendor: e.target.value })} className="w-auto min-w-36" aria-label="Vendor">
          <option value="">All vendors</option>
          {(Object.keys(VENDORS) as VendorId[])
            .filter((v) => facets.vendors[v] || filter.vendor === v)
            .map((v) => (
              <option key={v} value={v}>
                {VENDORS[v].label} ({facets.vendors[v] ?? 0})
              </option>
            ))}
        </Select>
        <span className="text-[13px] text-muted">
          {devices.length === total ? total : `${devices.length} of ${total}`} recorder{total === 1 ? "" : "s"}
        </span>
        {canManage ? (
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setModal({ kind: "new" })} disabled={stores.length === 0}>
              <Plus className="h-4 w-4" /> Add recorder
            </Button>
          </div>
        ) : null}
      </div>

      <Card className="overflow-visible">
        {devices.length === 0 ? (
          <EmptyState
            icon={<HardDrive className="h-5 w-5" />}
            title={total > 0 ? "No recorders match" : "No recorders"}
            description={
              total > 0
                ? "Try another connection mode, vendor or search."
                : stores.length === 0
                  ? "Create a site first, then add its NVR or DVR."
                  : "Add an NVR/DVR once and link its channels as cameras; credentials live on the recorder."
            }
            className="m-4"
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Recorder</TH>
                <TH>Site</TH>
                <TH>Connection</TH>
                <TH>Address</TH>
                <TH>Channels</TH>
                <TH>Last check</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {devices.map((d) => (
                <TR key={d.id} className={!d.isEnabled ? "opacity-60" : ""}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text">{d.name}</span>
                      <KindBadge kind={d.kind} />
                    </div>
                    <p className="text-[12px] text-faint">
                      <span className="font-medium text-muted" title={`${VENDORS[d.vendorId].protocol}. ${VENDORS[d.vendorId].notes}`}>
                        {d.vendorId === "tyco" ? VENDORS.tyco.label : vendorLabel(d.vendor)}
                      </span>
                      {[d.model, d.serialMasked ? `S/N ${d.serialMasked}` : null, d.firmware]
                        .filter(Boolean)
                        .map((x) => ` · ${x}`)
                        .join("")}
                    </p>
                    <DataQualityBadges flags={dataQualityFlags(d.notes)} className="mt-1" />
                  </TD>
                  <TD className="text-[13px]">
                    {d.storeName} <span className="text-faint">({d.storeCode})</span>
                  </TD>
                  <TD>
                    <ConnectionBadge state={d.linkState} />
                    <p className="mt-1 text-[11px] text-faint" title={CONNECTION_MODE_LABELS[d.connectionMode]?.description}>
                      {MODE_SHORT[d.connectionMode] ?? d.connectionMode}
                      {d.cloudPlatform ? (
                        <span className="ml-1 inline-flex items-center gap-1">
                          · <Cloud className="h-3 w-3" /> {d.cloudPlatform}
                        </span>
                      ) : null}
                    </p>
                  </TD>
                  <TD className="font-mono text-[12px] text-muted">
                    {d.host ? (
                      <>
                        {d.host}:{d.rtspPort}
                        <p className="text-[11px] text-faint">
                          {d.httpsEnabled ? "https" : "http"} {d.httpPort}
                        </p>
                      </>
                    ) : (
                      <span className="font-sans text-faint">No address yet</span>
                    )}
                  </TD>
                  <TD className="tabular-nums">
                    <Link href={`/cameras?device=${d.id}`} className="hover:text-accent">
                      <span className="font-medium text-success">{d.onlineCameraCount}</span>
                      <span className="text-faint"> / {d.cameraCount} online</span>
                    </Link>
                    {d.channelCount ? <p className="text-[11px] text-faint">{d.channelCount} ch capacity</p> : null}
                  </TD>
                  <TD className="text-[13px] text-muted" title={d.lastError ?? ""}>
                    {d.linkState === "PENDING" || d.linkState === "CLOUD" || d.linkState === "DISABLED" ? <span className="text-faint">Not monitored</span> : formatRelative(d.lastCheckedAt)}
                    {d.lastLatencyMs != null && d.linkState === "LIVE" ? <span className="text-[11px] text-faint"> · {d.lastLatencyMs} ms</span> : null}
                    {d.storageStatus ? (
                      <p className="text-[11px] text-faint">
                        {d.storageStatus}
                        {d.storageTotalMb ? ` · ${((d.storageFreeMb ?? 0) / 1024 / 1024).toFixed(1)} of ${(d.storageTotalMb / 1024 / 1024).toFixed(1)} TB free` : ""}
                      </p>
                    ) : null}
                    {d.lastError ? <p className={cn("max-w-[260px] truncate text-[11px]", d.linkState === "OFFLINE" ? "text-danger" : "text-faint")}>{d.lastError}</p> : null}
                  </TD>
                  <TD className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <Link href={`/cameras?device=${d.id}`} className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text" title="Show linked cameras">
                        <Camera className="h-4 w-4" />
                      </Link>
                      {canManage ? (
                        <div className="relative" ref={menuFor === d.id ? menuRef : undefined}>
                          <Button variant="ghost" size="icon" aria-label="More actions" onClick={() => setMenuFor(menuFor === d.id ? null : d.id)} disabled={pending}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                          {menuFor === d.id ? (
                            <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-border bg-surface p-1 text-left shadow-raised pop-in">
                              <MenuItem icon={<Pencil className="h-4 w-4" />} onClick={() => { setMenuFor(null); setModal({ kind: "edit", device: d }); }}>Edit</MenuItem>
                              {d.host ? (
                                <MenuItem icon={<Plug className="h-4 w-4" />} onClick={() => run("Connection test", () => testDeviceAction(d.id))}>
                                  Test connection
                                </MenuItem>
                              ) : null}
                              {isIsapiVendor(d.vendor) && (d.linkState === "LIVE" || d.linkState === "OFFLINE" || d.linkState === "CHECKING") ? (
                                <>
                                  <MenuItem icon={<ListPlus className="h-4 w-4" />} onClick={() => run("Channel import", () => importDeviceChannelsAction(d.id))}>Import channels</MenuItem>
                                  <MenuItem icon={<ListPlus className="h-4 w-4" />} onClick={() => run("Channel import", () => importDeviceChannelsAction(d.id, true))}>Import + use recorder names</MenuItem>
                                </>
                              ) : null}
                              <MenuItem icon={<Power className="h-4 w-4" />} onClick={() => run(d.isEnabled ? "Recorder disabled" : "Recorder enabled", () => toggleDeviceEnabledAction(d.id, !d.isEnabled))}>
                                {d.isEnabled ? "Disable" : "Enable"}
                              </MenuItem>
                              <div className="my-1 border-t border-border" />
                              <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onClick={() => { setMenuFor(null); setModal({ kind: "delete", device: d }); }}>Delete</MenuItem>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog open={modal?.kind === "new" || modal?.kind === "edit"} onClose={close} title={modal?.kind === "edit" ? `Edit ${modal.device.name}` : "Add recorder"} size="lg">
        <DeviceForm initial={modal?.kind === "edit" ? modal.device : undefined} stores={stores} onDone={done} onCancel={close} />
      </Dialog>

      <Dialog open={modal?.kind === "delete"} onClose={close} title={modal?.kind === "delete" ? `Delete ${modal.device.name}?` : ""} size="sm">
        {modal?.kind === "delete" && modal.device.cameraCount > 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {modal.device.cameraCount} camera(s) are linked to this recorder. They keep their names but lose their video source until linked to another recorder.
            </p>
            <Checkbox label="Unlink cameras and delete the recorder" description="Their streams are removed from the streaming server." checked={unlink} onChange={(e) => setUnlink(e.target.checked)} />
          </div>
        ) : (
          <p className="text-sm text-muted">The recorder and its status history are deleted. This cannot be undone.</p>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={pending}
            disabled={modal?.kind === "delete" && modal.device.cameraCount > 0 && !unlink}
            onClick={() => modal?.kind === "delete" && deleteDevice(modal.device)}
          >
            Delete
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

function MenuItem({ icon, children, onClick, danger }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-surface-2 ${danger ? "text-danger hover:bg-danger-soft" : "text-text"}`}>
      <span className="text-muted">{icon}</span>
      {children}
    </button>
  );
}
