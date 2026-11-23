"use client";

import { Camera, Check, ChevronDown, Search, Store as StoreIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/format";

export interface AccessStore {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
}

export interface AccessCamera {
  id: string;
  name: string;
  storeId: string;
  channel: number | null;
  deviceName: string | null;
  isEnabled: boolean;
}

/**
 * Location + camera assignment for one user. Fully controlled; renders the
 * hidden form fields the users server action reads:
 *   storeIds[]          assigned locations
 *   cameraLimitStores[] locations limited to specific cameras
 *   cameraIds[]         cameras granted inside those locations
 */
export function AccessPicker({
  stores,
  cameras,
  storeIds,
  onStoreIdsChange,
  limited,
  onLimitedChange,
  cameraIds,
  onCameraIdsChange,
  error,
}: {
  stores: AccessStore[];
  cameras: AccessCamera[];
  storeIds: Set<string>;
  onStoreIdsChange: (next: Set<string>) => void;
  limited: Set<string>;
  onLimitedChange: (next: Set<string>) => void;
  cameraIds: Set<string>;
  onCameraIdsChange: (next: Set<string>) => void;
  error?: string;
}) {
  const [storeQuery, setStoreQuery] = useState("");
  const camerasByStore = useMemo(() => {
    const m = new Map<string, AccessCamera[]>();
    for (const c of cameras) {
      const list = m.get(c.storeId) ?? [];
      list.push(c);
      m.set(c.storeId, list);
    }
    return m;
  }, [cameras]);

  const q = storeQuery.trim().toLowerCase();
  const filteredStores = q ? stores.filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q)) : stores;
  const selectedStores = stores.filter((s) => storeIds.has(s.id));

  const toggleStore = (id: string) => {
    const next = new Set(storeIds);
    if (next.has(id)) {
      next.delete(id);
      // Dropping a location also drops its camera-level selection.
      if (limited.has(id)) {
        const l = new Set(limited);
        l.delete(id);
        onLimitedChange(l);
      }
      const ids = new Set(cameraIds);
      for (const c of camerasByStore.get(id) ?? []) ids.delete(c.id);
      if (ids.size !== cameraIds.size) onCameraIdsChange(ids);
    } else {
      next.add(id);
    }
    onStoreIdsChange(next);
  };

  const setAllFiltered = (on: boolean) => {
    const next = new Set(storeIds);
    for (const s of filteredStores) {
      if (on) next.add(s.id);
      else next.delete(s.id);
    }
    if (!on) {
      const l = new Set(limited);
      const ids = new Set(cameraIds);
      for (const s of filteredStores) {
        l.delete(s.id);
        for (const c of camerasByStore.get(s.id) ?? []) ids.delete(c.id);
      }
      onLimitedChange(l);
      onCameraIdsChange(ids);
    }
    onStoreIdsChange(next);
  };

  const setMode = (storeId: string, specific: boolean) => {
    const l = new Set(limited);
    if (specific) {
      l.add(storeId);
      // Start from every camera selected so the admin removes the few to hide.
      const ids = new Set(cameraIds);
      const inStore = camerasByStore.get(storeId) ?? [];
      if (!inStore.some((c) => ids.has(c.id))) for (const c of inStore) ids.add(c.id);
      onCameraIdsChange(ids);
    } else {
      l.delete(storeId);
    }
    onLimitedChange(l);
  };

  return (
    <div className="space-y-4">
      {/* Hidden fields for the server action */}
      {[...storeIds].map((id) => (
        <input key={`s-${id}`} type="hidden" name="storeIds[]" value={id} />
      ))}
      {[...limited].filter((id) => storeIds.has(id)).map((id) => (
        <input key={`l-${id}`} type="hidden" name="cameraLimitStores[]" value={id} />
      ))}
      {cameras
        .filter((c) => cameraIds.has(c.id) && limited.has(c.storeId) && storeIds.has(c.storeId))
        .map((c) => (
          <input key={`c-${c.id}`} type="hidden" name="cameraIds[]" value={c.id} />
        ))}

      <section>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-muted">Locations</p>
          <span className="text-[12px] text-faint">
            {storeIds.size} of {stores.length} selected
          </span>
        </div>
        {stores.length === 0 ? (
          <p className="text-sm text-danger">No locations exist yet. Create a store, warehouse or office before adding store managers or viewers.</p>
        ) : (
          <div className="rounded-[6px] border border-border">
            <div className="flex items-center gap-2 border-b border-border p-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <Input value={storeQuery} onChange={(e) => setStoreQuery(e.target.value)} placeholder="Search locations by name or code" className="pl-8" aria-label="Search locations" />
              </div>
              <button type="button" onClick={() => setAllFiltered(true)} className="rounded-[4px] px-2 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent-soft">
                Select {q ? "matching" : "all"}
              </button>
              <button type="button" onClick={() => setAllFiltered(false)} className="rounded-[4px] px-2 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-surface-hover">
                Clear
              </button>
            </div>
            <div className="grid max-h-52 gap-0.5 overflow-y-auto p-1.5 sm:grid-cols-2">
              {filteredStores.map((s) => {
                const on = storeIds.has(s.id);
                return (
                  <label
                    key={s.id}
                    className={cn("flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm transition-colors hover:bg-surface-2", on && "bg-accent-soft/60 hover:bg-accent-soft")}
                  >
                    <input type="checkbox" checked={on} onChange={() => toggleStore(s.id)} className="h-4 w-4 accent-[var(--accent)]" />
                    <span className={cn("truncate", !s.isActive && "text-faint line-through")}>{s.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">{s.code}</span>
                  </label>
                );
              })}
              {filteredStores.length === 0 ? <p className="col-span-full px-2 py-3 text-center text-[13px] text-faint">No location matches &ldquo;{storeQuery}&rdquo;.</p> : null}
            </div>
          </div>
        )}
        {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
      </section>

      {selectedStores.length > 0 ? (
        <section>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="text-[13px] font-medium text-muted">Camera access</p>
            <span className="text-[12px] text-faint">&ldquo;All cameras&rdquo; also covers cameras added later</span>
          </div>
          <div className="divide-y divide-border overflow-hidden rounded-[6px] border border-border">
            {selectedStores.map((s) => (
              <StoreCameras
                key={s.id}
                store={s}
                cameras={camerasByStore.get(s.id) ?? []}
                specific={limited.has(s.id)}
                onModeChange={(specific) => setMode(s.id, specific)}
                selected={cameraIds}
                onSelectedChange={onCameraIdsChange}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function StoreCameras({
  store,
  cameras,
  specific,
  onModeChange,
  selected,
  onSelectedChange,
}: {
  store: AccessStore;
  cameras: AccessCamera[];
  specific: boolean;
  onModeChange: (specific: boolean) => void;
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(specific);
  const chosen = cameras.filter((c) => selected.has(c.id)).length;
  const q = query.trim().toLowerCase();
  const filtered = q ? cameras.filter((c) => c.name.toLowerCase().includes(q) || (c.deviceName ?? "").toLowerCase().includes(q) || String(c.channel ?? "").includes(q)) : cameras;
  const expanded = specific && open;

  const setMany = (list: AccessCamera[], on: boolean) => {
    const next = new Set(selected);
    for (const c of list) {
      if (on) next.add(c.id);
      else next.delete(c.id);
    }
    onSelectedChange(next);
  };

  const summary =
    cameras.length === 0 ? "No cameras yet" : specific ? `${chosen} of ${cameras.length} cameras` : `All ${cameras.length} camera${cameras.length === 1 ? "" : "s"}`;

  return (
    <div className="bg-surface">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => specific && setOpen((o) => !o)}
          className={cn("flex min-w-0 flex-1 items-center gap-2 text-left", !specific && "cursor-default")}
          aria-expanded={expanded}
          disabled={!specific}
        >
          <StoreIcon className="h-4 w-4 shrink-0 text-faint" />
          <span className="truncate text-sm font-medium text-text">{store.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-faint">{store.code}</span>
          <span className={cn("shrink-0 text-[12px]", specific && chosen === 0 ? "text-danger" : "text-muted")}>· {summary}</span>
          {specific ? <ChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-faint transition-transform duration-200", expanded && "rotate-180")} /> : null}
        </button>
        <div role="radiogroup" aria-label={`Camera access for ${store.name}`} className="inline-flex shrink-0 overflow-hidden rounded-[4px] border border-border-strong/70 text-[12px] font-medium">
          <ModeButton active={!specific} onClick={() => onModeChange(false)}>
            All cameras
          </ModeButton>
          <ModeButton
            active={specific}
            disabled={cameras.length === 0}
            onClick={() => {
              onModeChange(true);
              setOpen(true);
            }}
          >
            Specific cameras
          </ModeButton>
        </div>
      </div>

      <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <div className="border-t border-border bg-surface-2/40 px-3 py-2">
            <div className="mb-2 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search cameras, recorder or channel" className="pl-8" aria-label={`Search cameras in ${store.name}`} tabIndex={expanded ? 0 : -1} />
              </div>
              <button type="button" tabIndex={expanded ? 0 : -1} onClick={() => setMany(filtered, true)} className="rounded-[4px] px-2 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent-soft">
                Select {q ? "matching" : "all"}
              </button>
              <button type="button" tabIndex={expanded ? 0 : -1} onClick={() => setMany(filtered, false)} className="rounded-[4px] px-2 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-surface-hover">
                None
              </button>
            </div>
            <ul className="grid max-h-56 gap-0.5 overflow-y-auto sm:grid-cols-2">
              {filtered.map((c) => {
                const on = selected.has(c.id);
                return (
                  <li key={c.id}>
                    <label className={cn("flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm transition-colors hover:bg-surface-hover", on && "bg-accent-soft/60")}>
                      <input type="checkbox" checked={on} tabIndex={expanded ? 0 : -1} onChange={() => setMany([c], !on)} className="h-4 w-4 accent-[var(--accent)]" />
                      <Camera className="h-3.5 w-3.5 shrink-0 text-faint" />
                      <span className={cn("truncate", !c.isEnabled && "text-faint")}>{c.name}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-faint">
                        {c.channel != null ? `CH ${c.channel}` : ""}
                        {!c.isEnabled ? " · disabled" : ""}
                      </span>
                    </label>
                  </li>
                );
              })}
              {filtered.length === 0 ? <li className="col-span-full px-2 py-3 text-center text-[13px] text-faint">No camera matches &ldquo;{query}&rdquo;.</li> : null}
            </ul>
            {chosen === 0 ? <p className="mt-1.5 text-[12px] text-danger">Pick at least one camera, or switch back to &ldquo;All cameras&rdquo;.</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeButton({ active, disabled, onClick, children }: { active: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        active ? "bg-accent text-white" : "bg-surface text-muted hover:bg-surface-2 hover:text-text",
      )}
    >
      {active ? <Check className="h-3 w-3" /> : null}
      {children}
    </button>
  );
}
