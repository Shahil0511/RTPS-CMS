"use client";

import { Building2, Grid2x2, Grid3x3, LayoutGrid, Maximize2, Square, Store as StoreIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { WhepPlayer } from "@/components/player/whep-player";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { CameraStatus, SiteKind } from "@/db/schema";
import { cn } from "@/lib/format";

export interface LiveCamera {
  id: string;
  name: string;
  status: CameraStatus;
  isEnabled: boolean;
  store: { id: string; name: string; code: string; kind: SiteKind };
}

export interface LiveSite {
  id: string;
  name: string;
  code: string;
  kind: SiteKind;
}

type Tab = "stores" | "corporate";
type Layout = 1 | 4 | 9 | 16;
const LAYOUTS: Array<{ value: Layout; label: string; icon: React.ReactNode }> = [
  { value: 1, label: "Single", icon: <Square className="h-4 w-4" /> },
  { value: 4, label: "2×2", icon: <Grid2x2 className="h-4 w-4" /> },
  { value: 9, label: "3×3", icon: <Grid3x3 className="h-4 w-4" /> },
  { value: 16, label: "4×4", icon: <LayoutGrid className="h-4 w-4" /> },
];

const tabOf = (kind: SiteKind): Tab => (kind === "STORE" ? "stores" : "corporate");

/**
 * Live wall. Sites are split into two tabs: "Stores" (every retail store) and
 * "Corporate" (corporate offices and warehouses). Layout and camera selection
 * are remembered per user and site.
 */
export function LiveGrid({ cameras, sites, userId }: { cameras: LiveCamera[]; sites: LiveSite[]; userId: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const storeId = sp.get("store") ?? "";
  const selectedSite = sites.find((s) => s.id === storeId) ?? null;
  const tabParam = sp.get("tab");
  const tab: Tab = selectedSite ? tabOf(selectedSite.kind) : tabParam === "corporate" ? "corporate" : "stores";

  const storeSites = useMemo(() => sites.filter((s) => s.kind === "STORE"), [sites]);
  const corporateSites = useMemo(() => sites.filter((s) => s.kind !== "STORE"), [sites]);
  const tabSites = tab === "stores" ? storeSites : corporateSites;

  const storageKey = `vms-live:${userId}:${storeId || `tab-${tab}`}`;

  const [layout, setLayout] = useState<Layout>(4);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const visible = useMemo(
    () => cameras.filter((c) => c.isEnabled && (storeId ? c.store.id === storeId : tabOf(c.store.kind) === tab)),
    [cameras, storeId, tab],
  );

  // Restore saved layout/selection per user & site.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as { layout?: Layout; selected?: string[] };
        if (saved.layout) setLayout(saved.layout);
        setSelected(saved.selected ? saved.selected.filter((id) => visible.some((c) => c.id === id)) : null);
      } else {
        setSelected(null);
        setLayout(visible.length <= 1 ? 1 : visible.length <= 4 ? 4 : visible.length <= 9 ? 9 : 16);
      }
    } catch {
      // ignore
    }
    setPage(0);
    setHydrated(true);
  }, [storageKey, visible]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ layout, selected }));
    } catch {
      // ignore
    }
  }, [layout, selected, storageKey, hydrated]);

  const go = (next: { tab?: Tab; store?: string }) => {
    const qs = new URLSearchParams();
    const t = next.tab ?? tab;
    if (next.store) qs.set("store", next.store);
    else qs.set("tab", t);
    router.push(`/live?${qs.toString()}`);
  };

  const active = selected ? visible.filter((c) => selected.includes(c.id)) : visible;
  const pageCount = Math.max(1, Math.ceil(active.length / layout));
  const safePage = Math.min(page, pageCount - 1);
  const slice = active.slice(safePage * layout, safePage * layout + layout);

  const toggle = (id: string) => {
    setSelected((cur) => {
      const base = cur ?? visible.map((c) => c.id);
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  };

  const cols = layout === 1 ? "grid-cols-1" : layout === 4 ? "grid-cols-1 sm:grid-cols-2" : layout === 9 ? "grid-cols-2 lg:grid-cols-3" : "grid-cols-2 lg:grid-cols-4";
  const onlineCount = (siteId: string) => cameras.filter((c) => c.store.id === siteId && c.isEnabled && c.status === "ONLINE").length;
  const totalCount = (siteId: string) => cameras.filter((c) => c.store.id === siteId && c.isEnabled).length;

  return (
    <div className="space-y-3">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <TabButton active={tab === "stores"} onClick={() => go({ tab: "stores" })} icon={<StoreIcon className="h-4 w-4" />} label="Stores" count={storeSites.length} />
        <TabButton active={tab === "corporate"} onClick={() => go({ tab: "corporate" })} icon={<Building2 className="h-4 w-4" />} label="Corporate" count={corporateSites.length} />
      </div>

      {/* Site chips */}
      <div className="flex flex-wrap items-center gap-2">
        <SiteChip active={!storeId} onClick={() => go({ tab })} label={tab === "stores" ? "All stores" : "All corporate sites"} />
        {tabSites.map((s) => (
          <SiteChip key={s.id} active={storeId === s.id} onClick={() => go({ store: s.id })} label={s.name} meta={`${onlineCount(s.id)}/${totalCount(s.id)}`} offline={totalCount(s.id) > 0 && onlineCount(s.id) === 0} />
        ))}
        {tabSites.length === 0 ? <span className="text-[13px] text-muted">No {tab === "stores" ? "stores" : "corporate sites"} assigned to you.</span> : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_280px]">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-border">
              {LAYOUTS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  title={l.label}
                  aria-label={`${l.label} layout`}
                  onClick={() => {
                    setLayout(l.value);
                    setPage(0);
                  }}
                  className={cn("grid h-9 w-9 place-items-center text-muted hover:bg-surface-2", layout === l.value && "bg-accent-soft text-accent")}
                >
                  {l.icon}
                </button>
              ))}
            </div>
            {pageCount > 1 ? (
              <div className="flex items-center gap-1 text-sm text-muted">
                <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}>
                  Prev
                </Button>
                <span className="tabular-nums">
                  {safePage + 1} / {pageCount}
                </span>
                <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1}>
                  Next
                </Button>
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-2 text-[13px] text-muted">
              <span>
                {selectedSite ? selectedSite.name : tab === "stores" ? "All stores" : "All corporate sites"} · {active.length} camera{active.length === 1 ? "" : "s"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const el = document.getElementById("live-grid");
                  if (el) void el.requestFullscreen().catch(() => undefined);
                }}
              >
                <Maximize2 className="h-4 w-4" /> Wall mode
              </Button>
            </div>
          </div>

          {slice.length === 0 ? (
            <EmptyState title="No cameras to show" description={visible.length === 0 ? "No enabled cameras at this site." : "Select at least one camera from the list."} />
          ) : (
            <div id="live-grid" className={cn("grid gap-2 bg-bg", cols)}>
              {slice.map((c) => (
                <WhepPlayer key={c.id} cameraId={c.id} name={c.name} storeName={c.store.name} compact={layout >= 9} />
              ))}
            </div>
          )}
        </div>

        <aside className="rounded-card border border-border bg-surface shadow-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold">Cameras</p>
            <div className="flex gap-2 text-[12px]">
              <button type="button" className="text-accent hover:underline" onClick={() => setSelected(null)}>
                All
              </button>
              <button type="button" className="text-accent hover:underline" onClick={() => setSelected([])}>
                None
              </button>
            </div>
          </div>
          <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto">
            {visible.map((c) => {
              const checked = selected ? selected.includes(c.id) : true;
              return (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                    <input type="checkbox" checked={checked} onChange={() => toggle(c.id)} className="h-4 w-4 accent-[var(--accent)]" />
                    <StatusDot status={c.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">{c.name}</span>
                      <span className="block truncate text-[11px] text-faint">{c.store.name}</span>
                    </span>
                    {c.status === "OFFLINE" ? <Badge tone="danger">Offline</Badge> : null}
                  </label>
                </li>
              );
            })}
            {visible.length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted">No cameras</li> : null}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, count }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        "-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
        active ? "border-accent text-accent" : "border-transparent text-muted hover:text-text",
      )}
    >
      {icon}
      {label}
      <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", active ? "bg-accent-soft text-accent" : "bg-surface-2 text-faint")}>{count}</span>
    </button>
  );
}

function SiteChip({ active, onClick, label, meta, offline }: { active: boolean; onClick: () => void; label: string; meta?: string; offline?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] transition-colors",
        active ? "border-accent bg-accent text-white" : "border-border bg-surface text-text hover:border-border-strong hover:bg-surface-2",
      )}
    >
      {label}
      {meta ? <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", active ? "bg-white/20" : offline ? "bg-danger-soft text-danger" : "bg-surface-2 text-faint")}>{meta}</span> : null}
    </button>
  );
}
