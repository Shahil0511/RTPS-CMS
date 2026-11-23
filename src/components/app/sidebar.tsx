"use client";

import {
  Activity,
  BellRing,
  Building2,
  Camera,
  FileClock,
  HardDrive,
  LayoutDashboard,
  Menu,
  MonitorPlay,
  ScrollText,
  Settings,
  Users,
  Video,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/format";
import type { NavItem } from "./nav";

const ICONS: Record<NavItem["icon"], React.ComponentType<{ className?: string }>> = {
  dashboard: LayoutDashboard,
  live: MonitorPlay,
  playback: Video,
  health: Activity,
  stores: Building2,
  devices: HardDrive,
  cameras: Camera,
  users: Users,
  audit: ScrollText,
  settings: Settings,
  alerts: BellRing,
  reports: FileClock,
};

/** Jira-style side navigation: light surface, blue selected item with a leading indicator. */
export function Sidebar({ sections }: { sections: Array<{ title: string; items: NavItem[] }> }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  const nav = (
    <nav className="flex-1 overflow-y-auto px-2 py-3">
      {sections.map((section) => (
        <div key={section.title} className="mb-4">
          <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{section.title}</p>
          <ul className="space-y-px">
            {section.items.map((item) => {
              const Icon = ICONS[item.icon];
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "group relative flex h-9 items-center gap-3 rounded-[4px] px-3 text-[14px] font-medium",
                      active ? "bg-sidebar-active text-accent" : "text-sidebar-text hover:bg-surface-hover hover:text-text",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <span
                      className={cn(
                        "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-accent transition-transform duration-200",
                        active ? "scale-y-100" : "scale-y-0",
                      )}
                    />
                    <Icon className={cn("h-4 w-4 shrink-0 transition-transform duration-200", !active && "group-hover:scale-110")} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const brand = (
    <Link href="/" className="flex h-14 items-center gap-2.5 px-4">
      <span className="grid h-8 w-8 place-items-center rounded-[6px] bg-accent text-white shadow-sm">
        <Camera className="h-4 w-4" />
      </span>
      <div className="leading-tight">
        <p className="text-[15px] font-semibold text-text">Libas VMS</p>
        <p className="text-[11px] text-faint">Video management</p>
      </div>
    </Link>
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed left-3 top-3 z-40 rounded-[4px] border border-border bg-surface p-2 text-text shadow-card lg:hidden"
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </button>

      <aside className="sticky top-0 hidden h-dvh lg:flex lg:w-60 lg:shrink-0 lg:flex-col border-r border-border bg-sidebar">
        {brand}
        {nav}
        <div className="border-t border-border px-4 py-3 text-[11px] text-faint">v1.1 · NVR-synced playback</div>
      </aside>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-[rgba(9,30,66,0.54)] fade-in" onClick={() => setOpen(false)} />
          <aside className="slide-in absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-sidebar shadow-raised">
            <div className="relative">
              {brand}
              <button type="button" onClick={() => setOpen(false)} className="absolute right-3 top-4 text-faint hover:text-text" aria-label="Close navigation">
                <X className="h-5 w-5" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      ) : null}
    </>
  );
}
