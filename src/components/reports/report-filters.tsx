"use client";

import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/format";
import { RANGE_LABELS, RANGE_PRESETS, type RangePreset } from "./format";
import { reportQuery, type ReportSearch } from "./params";

interface StoreOption {
  id: string;
  name: string;
  code: string;
}

/**
 * Filter bar for /reports. Presets apply immediately; the custom range, location, type, status
 * and search apply on submit. Everything lives in the URL so the CSV export matches the screen.
 */
export function ReportFilters({
  values,
  preset,
  fromDay,
  toDay,
  stores,
}: {
  values: ReportSearch;
  preset: RangePreset;
  fromDay: string;
  toDay: string;
  stores: StoreOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [range, setRange] = useState<RangePreset>(preset);

  const go = (patch: Partial<Record<keyof ReportSearch, string | undefined>>) => {
    const qs = reportQuery(values, { ...patch, page: undefined });
    startTransition(() => router.push(qs ? `/reports?${qs}` : "/reports"));
  };

  const pickPreset = (p: RangePreset) => {
    setRange(p);
    if (p === "custom") return;
    go({ range: p, from: undefined, to: undefined });
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const val = (k: string) => {
      const v = fd.get(k);
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    go({
      range,
      from: range === "custom" ? val("from") : undefined,
      to: range === "custom" ? val("to") : undefined,
      store: val("store"),
      type: val("type"),
      status: val("status"),
      q: val("q"),
    });
  };

  return (
    <form onSubmit={submit} className={cn("rounded-card border border-border bg-surface p-3 shadow-card transition-opacity", pending && "opacity-70")} aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Date range" className="inline-flex rounded-[4px] border border-border-strong/70 bg-surface-2 p-0.5">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={range === p}
              onClick={() => pickPreset(p)}
              className={cn(
                "h-7 rounded-[3px] px-2.5 text-[13px] font-medium transition-colors duration-150",
                range === p ? "bg-surface text-accent shadow-card" : "text-muted hover:text-text",
              )}
            >
              {RANGE_LABELS[p]}
            </button>
          ))}
        </div>
        {range === "custom" ? (
          <div className="fade-in flex items-center gap-1.5">
            <Input name="from" type="date" defaultValue={fromDay} aria-label="From date" className="w-[150px]" />
            <span className="text-faint">–</span>
            <Input name="to" type="date" defaultValue={toDay} aria-label="To date" className="w-[150px]" />
          </div>
        ) : null}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-faint" />
          <Input name="q" defaultValue={values.q ?? ""} placeholder="Search camera, recorder, location, reason…" className="pl-8" />
        </div>
        <Select name="store" defaultValue={values.store ?? ""} aria-label="Location">
          <option value="">All locations</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.code})
            </option>
          ))}
        </Select>
        <Select name="type" defaultValue={values.type ?? ""} aria-label="Type">
          <option value="">Cameras and recorders</option>
          <option value="CAMERA">Cameras only</option>
          <option value="DEVICE">Recorders only</option>
        </Select>
        <Select name="status" defaultValue={values.status ?? ""} aria-label="Status">
          <option value="">Open and resolved</option>
          <option value="open">Still offline</option>
          <option value="closed">Resolved</option>
        </Select>
        <div className="flex gap-2">
          <Button type="submit" loading={pending}>
            {pending ? null : <Search className="h-4 w-4" />} Apply
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Clear filters" onClick={() => startTransition(() => router.push("/reports"))}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </form>
  );
}
