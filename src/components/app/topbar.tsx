"use client";

import { ChevronDown, KeyRound, LogOut, Search, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { Role } from "@/db/schema";
import { ROLE_LABELS } from "@/lib/auth/rbac";
import { cn } from "@/lib/format";
import { logoutAction } from "@/server/actions/auth";

/** Jira-style top bar: global search, status pill, theme and profile menu. */
export function Topbar({ user, streamingOnline }: { user: { name: string; email: string; role: Role }; streamingOnline: boolean | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // "/" focuses search, as in Jira.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && t && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => setOpen(false), [pathname]);

  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur lg:px-6">
      <form
        className="relative ml-11 w-full max-w-md lg:ml-0"
        onSubmit={(e) => {
          e.preventDefault();
          const q = query.trim();
          router.push(q ? `/cameras?q=${encodeURIComponent(q)}` : "/cameras");
        }}
      >
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search cameras, recorders, sites"
          aria-label="Search cameras"
          className="h-8 w-full rounded-[4px] border border-border bg-surface-2 pl-8 pr-10 text-[13px] text-text placeholder:text-faint transition-all hover:bg-surface-hover focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
        />
        <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-surface px-1.5 text-[10px] text-faint sm:block">/</kbd>
      </form>

      <div className="ml-auto flex items-center gap-1">
        {streamingOnline === null ? null : (
          <span
            className={cn(
              "mr-1 hidden items-center gap-2 rounded-full px-2.5 py-1 text-[12px] font-medium md:inline-flex",
              streamingOnline ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
            )}
            title={streamingOnline ? "Streaming server connected" : "Streaming server unreachable"}
          >
            <span className={cn("h-2 w-2 rounded-full", streamingOnline ? "status-pulse bg-success text-success" : "bg-danger")} />
            {streamingOnline ? "Streaming online" : "Streaming offline"}
          </span>
        )}
        <ThemeToggle className="rounded-[4px] p-2 text-muted hover:bg-surface-hover hover:text-text" />
        <div ref={ref} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2 rounded-[4px] px-1.5 py-1 hover:bg-surface-hover"
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-[11px] font-semibold text-white">{initials}</span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-[13px] font-medium text-text">{user.name}</span>
              <span className="block text-[11px] text-faint">{ROLE_LABELS[user.role]}</span>
            </span>
            <ChevronDown className={cn("h-4 w-4 text-faint transition-transform duration-200", open && "rotate-180")} />
          </button>
          {open ? (
            <div role="menu" className="pop-in absolute right-0 mt-1 w-64 rounded-[6px] border border-border bg-surface p-1 shadow-raised">
              <div className="px-3 py-2">
                <p className="text-sm font-medium text-text">{user.name}</p>
                <p className="truncate text-xs text-muted">{user.email}</p>
              </div>
              <div className="my-1 border-t border-border" />
              <Link href="/profile" className="flex items-center gap-2 rounded-[4px] px-3 py-2 text-sm text-text hover:bg-surface-hover" role="menuitem">
                <KeyRound className="h-4 w-4 text-muted" /> Change password
              </Link>
              <div className="flex items-center gap-2 rounded-[4px] px-3 py-2 text-sm text-muted">
                <ShieldCheck className="h-4 w-4" /> {ROLE_LABELS[user.role]}
              </div>
              <div className="my-1 border-t border-border" />
              <form action={logoutAction}>
                <button type="submit" className="flex w-full items-center gap-2 rounded-[4px] px-3 py-2 text-left text-sm text-danger hover:bg-danger-soft" role="menuitem">
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
