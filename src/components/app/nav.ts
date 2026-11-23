import type { Permission } from "@/lib/auth/rbac";

export interface NavItem {
  href: string;
  label: string;
  icon: "dashboard" | "live" | "playback" | "health" | "stores" | "devices" | "cameras" | "users" | "audit" | "settings" | "alerts" | "reports";
  permission?: Permission;
}

export const NAV_SECTIONS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "Monitor",
    items: [
      { href: "/", label: "Dashboard", icon: "dashboard" },
      { href: "/live", label: "Live View", icon: "live", permission: "live.view" },
      { href: "/playback", label: "Playback", icon: "playback", permission: "playback.view" },
      { href: "/health", label: "Health", icon: "health", permission: "health.view" },
      { href: "/reports", label: "Downtime Reports", icon: "reports", permission: "reports.view" },
    ],
  },
  {
    title: "Manage",
    items: [
      { href: "/stores", label: "Stores", icon: "stores", permission: "cameras.view" },
      { href: "/devices", label: "Recorders", icon: "devices", permission: "devices.view" },
      { href: "/cameras", label: "Cameras", icon: "cameras", permission: "cameras.view" },
      { href: "/users", label: "Users & Roles", icon: "users", permission: "users.manage" },
    ],
  },
  {
    title: "Govern",
    items: [
      { href: "/alerts", label: "Alerts", icon: "alerts", permission: "alerts.manage" },
      { href: "/audit", label: "Audit Logs", icon: "audit", permission: "audit.view" },
      { href: "/settings", label: "System", icon: "settings", permission: "settings.view" },
    ],
  },
];
