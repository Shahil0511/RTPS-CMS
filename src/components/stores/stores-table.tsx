"use client";

import { Building2, Mail, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ConnectionBadge } from "@/components/health/connection-badge";
import { LINK_STATE_META, OEM_GROUPS, type LinkState, type OemGroup } from "@/components/health/connection-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { SiteKind } from "@/db/schema";
import { cn } from "@/lib/format";
import { VENDORS, type VendorId } from "@/lib/vendors";
import { deleteStoreAction } from "@/server/actions/stores";
import { StoreForm, type StoreFormValues } from "./store-form";

export interface StoreRowData extends StoreFormValues {
  id: string;
  code: string;
  name: string;
  kind: SiteKind;
  timezone: string;
  isActive: boolean;
  email: string | null;
  vendors: VendorId[];
  oemGroups: OemGroup[];
  recorderCount: number;
  recorderStates: Partial<Record<LinkState, number>>;
  linkState: LinkState | "NONE";
  cameraCount: number;
  enabledCameraCount: number;
  onlineCount: number;
  offlineCount: number;
}

const KIND_META: Record<SiteKind, { label: string; tone: "accent" | "info" | "warning" }> = {
  STORE: { label: "Store", tone: "accent" },
  WAREHOUSE: { label: "Warehouse", tone: "warning" },
  CORPORATE: { label: "Corporate", tone: "info" },
};

/** Connection filter buckets. "OFFLINE" means a connected recorder is down; "NONE" means no recorder registered. */
type ConnFilter = "LIVE" | "OFFLINE" | "PENDING" | "CLOUD" | "NONE";
const CONN_FILTERS: Array<{ id: ConnFilter; label: string }> = [
  { id: "LIVE", label: LINK_STATE_META.LIVE.label },
  { id: "OFFLINE", label: LINK_STATE_META.OFFLINE.label },
  { id: "PENDING", label: LINK_STATE_META.PENDING.label },
  { id: "CLOUD", label: LINK_STATE_META.CLOUD.label },
  { id: "NONE", label: "No recorder" },
];

function matchesConn(s: StoreRowData, f: ConnFilter): boolean {
  if (f === "NONE") return s.recorderCount === 0;
  return (s.recorderStates[f] ?? 0) > 0;
}

export function StoresTable({ stores, canManage }: { stores: StoreRowData[]; canManage: boolean }) {
  const [editing, setEditing] = useState<StoreRowData | null | "new">(null);
  const [kind, setKind] = useState<SiteKind | "">("");
  const [oem, setOem] = useState<OemGroup | "">("");
  const [conn, setConn] = useState<ConnFilter | "">("");
  const [q, setQ] = useState("");
  const router = useRouter();
  const close = () => setEditing(null);
  const done = () => {
    close();
    router.refresh();
  };

  const counts = useMemo(() => {
    const byKind = new Map<string, number>();
    const byOem = new Map<string, number>();
    const byConn = new Map<string, number>();
    for (const s of stores) {
      byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
      for (const g of s.oemGroups) byOem.set(g, (byOem.get(g) ?? 0) + 1);
      for (const f of CONN_FILTERS) if (matchesConn(s, f.id)) byConn.set(f.id, (byConn.get(f.id) ?? 0) + 1);
    }
    return { byKind, byOem, byConn };
  }, [stores]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return stores.filter((s) => {
      if (kind && s.kind !== kind) return false;
      if (oem && !s.oemGroups.includes(oem)) return false;
      if (conn && !matchesConn(s, conn)) return false;
      if (needle) {
        const hay = [s.name, s.code, s.city, s.region, s.address, s.email, ...s.vendors.map((v) => VENDORS[v].label)].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [stores, kind, oem, conn, q]);

  const filtered = Boolean(kind || oem || conn || q.trim());
  const reset = () => {
    setKind("");
    setOem("");
    setConn("");
    setQ("");
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, city, email, OEM" className="w-72 pl-8" aria-label="Search locations" />
        </div>
        <span className="text-[13px] text-muted">
          {filtered ? `${visible.length} of ${stores.length}` : stores.length} location{stores.length === 1 ? "" : "s"}
        </span>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={reset}>
            <X className="h-3.5 w-3.5" /> Clear filters
          </Button>
        ) : null}
        {canManage ? (
          <div className="ml-auto">
            <Button onClick={() => setEditing("new")}>
              <Plus className="h-4 w-4" /> Add location
            </Button>
          </div>
        ) : null}
      </div>

      {stores.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
          <ChipGroup label="Type">
            {(Object.keys(KIND_META) as SiteKind[])
              .filter((k) => counts.byKind.get(k))
              .map((k) => (
                <Chip key={k} active={kind === k} onClick={() => setKind(kind === k ? "" : k)} count={counts.byKind.get(k) ?? 0}>
                  {KIND_META[k].label}
                </Chip>
              ))}
          </ChipGroup>
          <ChipGroup label="OEM">
            {OEM_GROUPS.filter((g) => counts.byOem.get(g.id)).map((g) => (
              <Chip key={g.id} active={oem === g.id} onClick={() => setOem(oem === g.id ? "" : g.id)} count={counts.byOem.get(g.id) ?? 0}>
                {g.label}
              </Chip>
            ))}
          </ChipGroup>
          <ChipGroup label="Connection">
            {CONN_FILTERS.filter((f) => counts.byConn.get(f.id)).map((f) => (
              <Chip key={f.id} active={conn === f.id} onClick={() => setConn(conn === f.id ? "" : f.id)} count={counts.byConn.get(f.id) ?? 0} tone={f.id === "OFFLINE" ? "danger" : undefined}>
                {f.label}
              </Chip>
            ))}
          </ChipGroup>
        </div>
      ) : null}

      <Card className="overflow-hidden">
        {stores.length === 0 ? (
          <EmptyState icon={<Building2 className="h-5 w-5" />} title="No locations" description={canManage ? "Create the first store, warehouse or office to start adding recorders." : "No location has been assigned to you yet."} className="m-4" />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Search className="h-5 w-5" />}
            title="No locations match"
            description="Try a different search or clear the filters."
            action={
              <Button variant="secondary" size="sm" onClick={reset}>
                Clear filters
              </Button>
            }
            className="m-4"
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Location</TH>
                <TH>OEM</TH>
                <TH>Recorders</TH>
                <TH>Cameras</TH>
                <TH>Store email</TH>
                <TH>Status</TH>
                {canManage ? <TH className="text-right">Actions</TH> : null}
              </tr>
            </THead>
            <TBody>
              {visible.map((s) => (
                <TR key={s.id} className={!s.isActive ? "opacity-60" : ""}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <Link href={`/cameras?store=${s.id}`} className="font-medium text-text hover:text-accent">
                        {s.name}
                      </Link>
                      <Badge tone={KIND_META[s.kind].tone}>{KIND_META[s.kind].label}</Badge>
                    </div>
                    <p className="text-[12px] text-faint">
                      <span className="font-mono">{s.code}</span>
                      {[s.city, s.region].filter(Boolean).length ? ` · ${[s.city, s.region].filter(Boolean).join(", ")}` : ""}
                    </p>
                  </TD>
                  <TD>
                    {s.vendors.length === 0 ? (
                      <span className="text-[13px] text-faint">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {s.vendors.map((v) => (
                          <span key={v} className="rounded-[3px] border border-border bg-surface-2 px-1.5 py-px text-[11px] font-medium text-text" title={`${VENDORS[v].label}: ${VENDORS[v].protocol}`}>
                            {VENDORS[v].label}
                          </span>
                        ))}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <Link href={`/devices?store=${s.id}`} className="group inline-flex flex-col items-start gap-1">
                      <ConnectionBadge state={s.linkState} />
                      <span className="text-[11px] text-faint group-hover:text-accent">{breakdown(s)}</span>
                    </Link>
                  </TD>
                  <TD className="tabular-nums">
                    {s.enabledCameraCount === 0 ? (
                      <span className="text-[13px] text-faint">{s.cameraCount ? `${s.cameraCount} disabled` : "None linked"}</span>
                    ) : (
                      <>
                        <span className={cn("font-medium", s.onlineCount === s.enabledCameraCount ? "text-success" : "text-text")}>{s.onlineCount}</span>
                        <span className="text-faint"> / {s.enabledCameraCount} online</span>
                        {s.offlineCount ? <p className="text-[11px] text-danger">{s.offlineCount} offline</p> : null}
                      </>
                    )}
                  </TD>
                  <TD className="text-[13px]">
                    {s.email ? (
                      <a href={`mailto:${s.email}`} className="inline-flex max-w-[220px] items-center gap-1.5 truncate text-muted hover:text-accent" title={s.email}>
                        <Mail className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{s.email}</span>
                      </a>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </TD>
                  <TD>{s.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</TD>
                  {canManage ? (
                    <TD className="text-right">
                      <div className="inline-flex gap-1">
                        <Button variant="ghost" size="icon" aria-label="Edit location" onClick={() => setEditing(s)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <ConfirmButton
                          variant="ghost"
                          size="icon"
                          aria-label="Delete location"
                          title={`Delete ${s.name}?`}
                          description={
                            s.recorderCount > 0
                              ? `This location still has ${s.recorderCount} recorder(s). Move or delete them first.`
                              : s.cameraCount > 0
                                ? `This location still has ${s.cameraCount} camera(s). Move or delete them first.`
                                : "This cannot be undone."
                          }
                          confirmLabel="Delete"
                          action={() => deleteStoreAction(s.id)}
                          onDone={(st) => st.ok && router.refresh()}
                          disabled={s.cameraCount > 0 || s.recorderCount > 0}
                        >
                          <Trash2 className="h-4 w-4 text-danger" />
                        </ConfirmButton>
                      </div>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog open={editing !== null} onClose={close} title={editing === "new" ? "Add location" : "Edit location"} size="lg">
        <StoreForm initial={editing && editing !== "new" ? editing : undefined} onDone={done} onCancel={close} />
      </Dialog>
    </>
  );
}

function breakdown(s: StoreRowData): string {
  if (s.recorderCount === 0) return "No recorder registered";
  const parts = (["LIVE", "OFFLINE", "CHECKING", "PENDING", "CLOUD", "DISABLED"] as const)
    .filter((k) => s.recorderStates[k])
    .map((k) => `${s.recorderStates[k]} ${LINK_STATE_META[k].label.toLowerCase()}`);
  return `${s.recorderCount} recorder${s.recorderCount === 1 ? "" : "s"}${parts.length > 1 || s.recorderCount > 1 ? ` · ${parts.join(", ")}` : ""}`;
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</span>
      {children}
    </div>
  );
}

function Chip({ active, onClick, count, tone, children }: { active: boolean; onClick: () => void; count: number; tone?: "danger"; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium transition-colors duration-150",
        active ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-muted hover:border-border-strong hover:text-text",
      )}
    >
      {children}
      <span className={cn("tabular-nums", active ? "text-accent" : tone === "danger" ? "text-danger" : "text-faint")}>{count}</span>
    </button>
  );
}
