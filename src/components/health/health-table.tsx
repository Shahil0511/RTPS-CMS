"use client";

import { Activity, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { CameraStatus } from "@/db/schema";
import { cn, formatRelative } from "@/lib/format";

interface Item {
  id: string;
  name: string;
  store: string;
  storeId: string;
  host: string;
  port: number;
  status: CameraStatus;
  isEnabled: boolean;
  recordEnabled: boolean;
  lastCheckedAt: string | null;
  lastOnlineAt: string | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  videoCodec: string | null;
  resolution: string | null;
  readerCount: number;
  uptime24h: number | null;
}

type Filter = "all" | "online" | "offline" | "unknown";

export function HealthTable({ stores, refreshSeconds }: { stores: Array<{ id: string; name: string }>; refreshSeconds: number }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [storeId, setStoreId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/health${storeId ? `?storeId=${storeId}` : ""}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load (${res.status})`);
        const data = (await res.json()) as { items: Item[] };
        if (!cancelled) {
          setItems(data.items);
          setUpdatedAt(new Date());
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, refreshSeconds * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [storeId, refreshSeconds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (filter !== "all" && (!i.isEnabled || i.status.toLowerCase() !== filter)) return false;
      if (q && !`${i.name} ${i.store} ${i.host}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, filter, search]);

  const counts = useMemo(() => {
    const enabled = (items ?? []).filter((i) => i.isEnabled);
    return {
      all: items?.length ?? 0,
      online: enabled.filter((i) => i.status === "ONLINE").length,
      offline: enabled.filter((i) => i.status === "OFFLINE").length,
      unknown: enabled.filter((i) => i.status === "UNKNOWN").length,
    };
  }, [items]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <div className="flex overflow-hidden rounded-lg border border-border text-[13px]">
          {(["all", "online", "offline", "unknown"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn("px-3 py-1.5 capitalize hover:bg-surface-2", filter === f && "bg-accent-soft font-medium text-accent")}
            >
              {f} <span className="ml-1 tabular-nums text-faint">{counts[f]}</span>
            </button>
          ))}
        </div>
        <Select value={storeId} onChange={(e) => setStoreId(e.target.value)} className="w-auto min-w-44" aria-label="Store">
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search camera, store, host" className="w-60 pl-8" />
        </div>
        <span className="ml-auto text-[12px] text-faint">
          {error ? <span className="text-danger">{error}</span> : updatedAt ? `Updated ${formatRelative(updatedAt)} · auto-refresh ${refreshSeconds}s` : "Loading…"}
        </span>
      </div>

      {items && filtered.length === 0 ? (
        <EmptyState icon={<Activity className="h-5 w-5" />} title="No cameras match" className="m-4" />
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Camera</TH>
              <TH>Status</TH>
              <TH>Uptime 24h</TH>
              <TH>Latency</TH>
              <TH>Stream</TH>
              <TH>Last check</TH>
              <TH>Last online</TH>
              <TH>Detail</TH>
            </tr>
          </THead>
          <TBody>
            {(items ?? []).length === 0 && !items
              ? Array.from({ length: 5 }).map((_, i) => (
                  <TR key={i}>
                    <TD colSpan={8}>
                      <div className="h-4 w-full animate-pulse rounded bg-surface-2" />
                    </TD>
                  </TR>
                ))
              : filtered.map((i) => (
                  <TR key={i.id}>
                    <TD>
                      <Link href={`/live/${i.id}`} className="font-medium text-text hover:text-accent">
                        {i.name}
                      </Link>
                      <p className="text-[12px] text-faint">
                        {i.store} · <span className="font-mono">{i.host}:{i.port}</span>
                      </p>
                    </TD>
                    <TD>
                      <StatusBadge status={i.status} enabled={i.isEnabled} />
                    </TD>
                    <TD>
                      <UptimeBar value={i.uptime24h} />
                    </TD>
                    <TD className="tabular-nums text-[13px]">{i.lastLatencyMs != null ? `${i.lastLatencyMs} ms` : "—"}</TD>
                    <TD className="text-[13px]">
                      {i.videoCodec ? (
                        <span>
                          {i.videoCodec}
                          {i.resolution ? <span className="text-faint"> · {i.resolution}</span> : null}
                        </span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                      {i.recordEnabled ? <Badge tone="info" className="ml-2">REC</Badge> : null}
                      {i.readerCount > 0 ? <span className="ml-2 text-[12px] text-faint">{i.readerCount} viewing</span> : null}
                    </TD>
                    <TD className="text-[13px] text-muted">{formatRelative(i.lastCheckedAt)}</TD>
                    <TD className="text-[13px] text-muted">{formatRelative(i.lastOnlineAt)}</TD>
                    <TD className="max-w-[320px] truncate text-[12px] text-faint" title={i.lastError ?? ""}>
                      {i.lastError ?? ""}
                    </TD>
                  </TR>
                ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function UptimeBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[12px] text-faint">no data</span>;
  const tone = value >= 99 ? "bg-success" : value >= 90 ? "bg-warning" : "bg-danger";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-2">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[12px] tabular-nums">{value}%</span>
    </div>
  );
}
