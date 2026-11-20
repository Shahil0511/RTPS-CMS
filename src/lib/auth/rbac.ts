import type { Role } from "@/db/schema";
import type { SessionUser } from "./session";

/**
 * Role model
 *  ADMIN   - full control: users, stores, cameras, settings, audit, all streams.
 *  MANAGER - manage cameras and view everything within assigned stores.
 *  VIEWER  - live view, playback and health within assigned stores.
 */
export const PERMISSIONS = {
  "users.manage": ["ADMIN"],
  "stores.manage": ["ADMIN"],
  "cameras.manage": ["ADMIN", "MANAGER"],
  "cameras.view": ["ADMIN", "MANAGER", "VIEWER"],
  "devices.manage": ["ADMIN", "MANAGER"],
  "devices.view": ["ADMIN", "MANAGER", "VIEWER"],
  "live.view": ["ADMIN", "MANAGER", "VIEWER"],
  "playback.view": ["ADMIN", "MANAGER", "VIEWER"],
  "playback.export": ["ADMIN", "MANAGER"],
  "health.view": ["ADMIN", "MANAGER", "VIEWER"],
  "health.run": ["ADMIN", "MANAGER"],
  "audit.view": ["ADMIN", "MANAGER"],
  "audit.export": ["ADMIN"],
  "settings.view": ["ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(user: Pick<SessionUser, "role">, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(user.role);
}

export function rolesFor(permission: Permission): Role[] {
  return [...PERMISSIONS[permission]];
}

/** True when the user may act on the given store. */
export function canAccessStore(user: SessionUser, storeId: string): boolean {
  if (user.isAdmin) return true;
  return user.storeIds.includes(storeId);
}

/** Returns the store-id filter for queries: null means "no restriction". */
export function storeScope(user: SessionUser): string[] | null {
  return user.isAdmin ? null : user.storeIds;
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  MANAGER: "Manager",
  VIEWER: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN: "Full access to every store, user, camera and system setting.",
  MANAGER: "Manages cameras and views live, playback, health and audit for assigned stores.",
  VIEWER: "Views live video, playback and health for assigned stores.",
};
