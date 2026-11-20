"use client";

import { Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";

export function AuditFilters({ actions, values }: { actions: string[]; values: Record<string, string | undefined> }) {
  const router = useRouter();

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const qs = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string" && v.trim()) qs.set(k, v.trim());
    }
    router.push(`/audit?${qs.toString()}`);
  };

  return (
    <form onSubmit={submit} className="grid gap-2 rounded-card border border-border bg-surface p-3 shadow-card sm:grid-cols-2 lg:grid-cols-6">
      <div className="relative lg:col-span-2">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-faint" />
        <Input name="q" defaultValue={values.q ?? ""} placeholder="Search label, details, IP…" className="pl-8" />
      </div>
      <Select name="action" defaultValue={values.action ?? ""}>
        <option value="">All actions</option>
        {actions.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </Select>
      <Input name="actor" defaultValue={values.actor ?? ""} placeholder="Actor email" />
      <Input name="from" type="date" defaultValue={values.from ?? ""} aria-label="From date" />
      <div className="flex gap-2">
        <Input name="to" type="date" defaultValue={values.to ?? ""} aria-label="To date" />
        <Button type="submit" size="icon" aria-label="Apply filters">
          <Search className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label="Clear filters" onClick={() => router.push("/audit")}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
