"use client";

import { Camera, HardDrive, MonitorPlay, MoreHorizontal, Pencil, Plug, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { ConnectionBadge } from "@/components/health/connection-badge";
import type { LinkState } from "@/components/health/connection-state";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { CameraStatus } from "@/db/schema";
import { formatRelative } from "@/lib/format";
import { deleteCameraAction, restartCameraAction, testCameraAction, toggleCameraEnabledAction } from "@/server/actions/cameras";
import { CameraForm, type CameraFormValues, type DeviceOptionData } from "./camera-form";
import { ImportDialog } from "./import-dialog";

export interface CameraRowData extends CameraFormValues {
  id: string;
  storeId: string;
  storeName: string;
  storeCode: string;
  name: string;
  pathName: string;
  deviceId: string | null;
  deviceName: string | null;
  /** Vendor label of the parent recorder (e.g. "CP Plus", "Tyco Holis"). */
  deviceVendor?: string | null;
  /** Connection state of the parent recorder; cameras of a pending/cloud-only recorder are not monitored. */
  deviceLinkState?: LinkState | null;
  channel: number | null;
  host: string | null;
  port: number;
  rtspPath: string;
  transport: "tcp" | "udp" | "automatic";
  recordEnabled: boolean;
  retentionDays: number;
  isEnabled: boolean;
  status: CameraStatus;
  lastError: string | null;
  videoCodec: string | null;
  resolution: string | null;
  lastCheckedAt: string | null;
}

type Modal = { kind: "new" } | { kind: "edit"; camera: CameraRowData } | { kind: "import" } | { kind: "delete"; camera: CameraRowData } | null;

export function CamerasTable({
  cameras,
  stores,
  devices,
  canManage,
  defaults,
  filter,
}: {
  cameras: CameraRowData[];
  stores: Array<{ id: string; name: string; code: string }>;
  devices: DeviceOptionData[];
  canManage: boolean;
  defaults: { recordEnabled: boolean; retentionDays: number };
  filter: { store: string; device: string; q: string };
}) {
  const [modal, setModal] = useState<Modal>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
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

  const close = () => setModal(null);
  const done = () => {
    close();
    router.refresh();
  };

  const applyFilter = (next: Partial<typeof filter>) => {
    const qs = new URLSearchParams();
    const f = { ...filter, ...next };
    if (f.store) qs.set("store", f.store);
    if (f.device) qs.set("device", f.device);
    if (f.q) qs.set("q", f.q);
    router.push(`/cameras${qs.size ? `?${qs}` : ""}`);
  };

  const run = (label: string, fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      setMenuFor(null);
      const r = await fn();
      if (r.ok) toast.success(label, r.message);
      else toast.error(`${label} failed`, r.error ?? r.message);
      router.refresh();
    });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={filter.store} onChange={(e) => applyFilter({ store: e.target.value })} className="w-auto min-w-48" aria-label="Store">
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        {devices.length > 0 ? (
          <Select value={filter.device} onChange={(e) => applyFilter({ device: e.target.value })} className="w-auto min-w-48" aria-label="Recorder">
            <option value="">All recorders</option>
            {devices
              .filter((d) => !filter.store || d.storeId === filter.store)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </Select>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyFilter({ q: String(new FormData(e.currentTarget).get("q") ?? "") });
          }}
          className="relative"
        >
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
          <Input name="q" defaultValue={filter.q} placeholder="Search name, recorder, host, path" className="w-64 pl-8" />
        </form>
        <span className="text-[13px] text-muted">{cameras.length} camera{cameras.length === 1 ? "" : "s"}</span>
        {canManage ? (
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => setModal({ kind: "import" })}>
              <Upload className="h-4 w-4" /> Bulk import
            </Button>
            <Button onClick={() => setModal({ kind: "new" })} disabled={stores.length === 0}>
              <Plus className="h-4 w-4" /> Add camera
            </Button>
          </div>
        ) : null}
      </div>

      <Card className="overflow-visible">
        {cameras.length === 0 ? (
          <EmptyState
            icon={<Camera className="h-5 w-5" />}
            title="No cameras"
            description={stores.length === 0 ? "Create a store first, then add cameras to it." : "Add cameras one by one or paste an NVR channel list to import them in bulk."}
            className="m-4"
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Camera</TH>
                <TH>Store</TH>
                <TH>Source</TH>
                <TH>Vendor</TH>
                <TH>Status</TH>
                <TH>Recording</TH>
                <TH>Checked</TH>
                <TH className="text-right">Actions</TH>
              </tr>
            </THead>
            <TBody>
              {cameras.map((c) => (
                <TR key={c.id} className={!c.isEnabled ? "opacity-60" : ""}>
                  <TD>
                    <Link href={`/live/${c.id}`} className="font-medium text-text hover:text-accent">
                      {c.name}
                    </Link>
                    <p className="font-mono text-[12px] text-faint">{c.pathName}</p>
                  </TD>
                  <TD className="text-[13px]">
                    {c.storeName} <span className="text-faint">({c.storeCode})</span>
                  </TD>
                  <TD className="text-[12px] text-muted">
                    {c.deviceId ? (
                      <span className="inline-flex items-center gap-1.5">
                        <HardDrive className="h-3.5 w-3.5 text-faint" />
                        <Link href={`/cameras?device=${c.deviceId}`} className="font-medium text-text hover:text-accent">
                          {c.deviceName ?? "Recorder"}
                        </Link>
                        {c.channel ? <span className="text-muted">· ch {c.channel}</span> : null}
                      </span>
                    ) : c.host ? (
                      <span className="font-mono">
                        {c.host}:{c.port}
                      </span>
                    ) : (
                      <span className="text-warning">No source</span>
                    )}
                    <p className="font-mono text-[11px] text-faint">
                      {c.rtspPath}
                      <span className="ml-1 text-[10px] uppercase">{c.transport}</span>
                    </p>
                  </TD>
                  <TD className="text-[13px]">
                    {c.deviceVendor ? <span className="text-text">{c.deviceVendor}</span> : <span className="text-faint">{c.deviceId ? "—" : "Standalone"}</span>}
                  </TD>
                  <TD>
                    {c.isEnabled && (c.deviceLinkState === "PENDING" || c.deviceLinkState === "CLOUD") ? (
                      <ConnectionBadge state={c.deviceLinkState} />
                    ) : (
                      <StatusBadge status={c.status} enabled={c.isEnabled} />
                    )}
                    {c.videoCodec ? <p className="mt-1 text-[11px] text-faint">{c.videoCodec}{c.resolution ? ` · ${c.resolution}` : ""}</p> : null}
                  </TD>
                  <TD>{c.recordEnabled ? <Badge tone="info">{c.retentionDays ? `${c.retentionDays}d` : "forever"}</Badge> : <Badge>Off</Badge>}</TD>
                  <TD className="text-[13px] text-muted" title={c.lastError ?? ""}>
                    {formatRelative(c.lastCheckedAt)}
                  </TD>
                  <TD className="text-right">
                    <div className="inline-flex items-center gap-1">
                      <Link href={`/live/${c.id}`} className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text" title="Open live view">
                        <MonitorPlay className="h-4 w-4" />
                      </Link>
                      {canManage ? (
                        <div className="relative" ref={menuFor === c.id ? menuRef : undefined}>
                          <Button variant="ghost" size="icon" aria-label="More actions" onClick={() => setMenuFor(menuFor === c.id ? null : c.id)} disabled={pending}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                          {menuFor === c.id ? (
                            <div className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-border bg-surface p-1 text-left shadow-raised pop-in">
                              <MenuItem icon={<Pencil className="h-4 w-4" />} onClick={() => { setMenuFor(null); setModal({ kind: "edit", camera: c }); }}>Edit</MenuItem>
                              <MenuItem icon={<Plug className="h-4 w-4" />} onClick={() => run("Connection test", () => testCameraAction(c.id))}>Test connection</MenuItem>
                              <MenuItem icon={<RefreshCw className="h-4 w-4" />} onClick={() => run("Stream restart", () => restartCameraAction(c.id))}>Restart stream</MenuItem>
                              <MenuItem icon={<Camera className="h-4 w-4" />} onClick={() => run(c.isEnabled ? "Camera disabled" : "Camera enabled", () => toggleCameraEnabledAction(c.id, !c.isEnabled))}>
                                {c.isEnabled ? "Disable" : "Enable"}
                              </MenuItem>
                              <div className="my-1 border-t border-border" />
                              <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onClick={() => { setMenuFor(null); setModal({ kind: "delete", camera: c }); }}>Delete</MenuItem>
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

      <Dialog open={modal?.kind === "new" || modal?.kind === "edit"} onClose={close} title={modal?.kind === "edit" ? `Edit ${modal.camera.name}` : "Add camera"} size="lg">
        <CameraForm initial={modal?.kind === "edit" ? modal.camera : undefined} stores={stores} devices={devices} defaults={defaults} onDone={done} onCancel={close} />
      </Dialog>

      <Dialog open={modal?.kind === "import"} onClose={close} title="Bulk import cameras" description="Paste an NVR channel list to create many cameras at once." size="lg">
        <ImportDialog stores={stores} defaultStoreId={filter.store || undefined} defaults={defaults} onDone={done} onCancel={close} />
      </Dialog>

      <Dialog open={modal?.kind === "delete"} onClose={close} title={modal?.kind === "delete" ? `Delete ${modal.camera.name}?` : ""} size="sm">
        <p className="text-sm text-muted">The camera is removed from the streaming server and its status history is deleted. Recorded files stay on disk until retention removes them.</p>
        <DialogFooter>
          <Button variant="secondary" onClick={close} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" loading={pending} onClick={() => modal?.kind === "delete" && run("Camera deleted", () => deleteCameraAction(modal.camera.id).then((r) => { close(); return r; }))}>
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
