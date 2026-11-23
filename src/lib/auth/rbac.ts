import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { cameras, type Role } from "@/db/schema";
import type { SessionUser } from "./session";

/**
 * Role model
 *  ADMIN   - full control: users, stores, cameras, settings, audit, all streams.
 *  MANAGER - manage cameras and view everything within assigned stores.
 *  VIEWER  - live view, playback and health within assigned stores.
 *
 * Within an assigned store a user may further be limited to specific cameras
 * (vms.user_stores.camera_limited + vms.user_cameras, surfaced as
 * SessionUser.cameraScope). Footage download is
 * the role's "playback.export" right unless users.allow_download overrides it.
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
  /** Alert recipients, alert settings and the email outbox. */
  "alerts.manage": ["ADMIN"],
  /** Downtime reports, scoped to the user's own stores. */
  "reports.view": ["ADMIN", "MANAGER", "VIEWER"],
  "reports.export": ["ADMIN", "MANAGER"],
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

type ScopedUser = Pick<SessionUser, "isAdmin" | "storeIds" | "cameraScope">;

/** Camera ids the user is limited to inside one store, or null when every camera of that store is visible. */
export function cameraLimitFor(user: ScopedUser, storeId: string): string[] | null {
  if (user.isAdmin) return null;
  return Object.prototype.hasOwnProperty.call(user.cameraScope, storeId) ? (user.cameraScope[storeId] ?? []) : null;
}

/**
 * True when the user sees every camera of the store (admin, or assigned without a camera limit).
 * Only such users may change recorders or camera sources there: a camera-limited user could
 * otherwise repoint a granted camera at another channel, or move/rename recorders to reveal
 * cameras they were not granted.
 */
export function hasWholeStore(user: ScopedUser, storeId: string): boolean {
  if (user.isAdmin) return true;
  return user.storeIds.includes(storeId) && cameraLimitFor(user, storeId) === null;
}

export const WHOLE_STORE_REQUIRED = "This needs access to every camera at the location. Ask an administrator.";

/** True when the user may see/open this camera (store assignment plus any camera-level restriction). */
export function canAccessCamera(user: ScopedUser, camera: { id: string; storeId: string }): boolean {
  if (user.isAdmin) return true;
  if (!user.storeIds.includes(camera.storeId)) return false;
  const limit = cameraLimitFor(user, camera.storeId);
  return limit === null || limit.includes(camera.id);
}

/**
 * Drizzle WHERE fragment over vms.cameras restricting rows to what the user may
 * see. Returns undefined for "no restriction" (admin). Combine with and(...).
 */
export function cameraScopeFilter(user: ScopedUser): SQL | undefined {
  if (user.isAdmin) return undefined;
  const whole: string[] = [];
  const parts: SQL[] = [];
  for (const storeId of user.storeIds) {
    const limit = cameraLimitFor(user, storeId);
    if (limit === null) whole.push(storeId);
    else if (limit.length > 0) parts.push(and(eq(cameras.storeId, storeId), inArray(cameras.id, limit)) as SQL);
  }
  if (whole.length > 0) parts.unshift(inArray(cameras.storeId, whole));
  if (parts.length === 0) return sql`false`;
  return parts.length === 1 ? parts[0] : (or(...parts) as SQL);
}

/** Effective footage-download right (per-user override, else role default). */
export function canDownload(user: Pick<SessionUser, "canDownload">): boolean {
  return user.canDownload === true;
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  MANAGER: "Store Manager",
  VIEWER: "Viewer",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  ADMIN: "Full access to every location, user, camera and system setting.",
  MANAGER: "Runs assigned locations: manages their cameras and recorders, watches live and recorded footage, sees health and audit.",
  VIEWER: "Watches live and recorded footage and sees camera health for assigned locations and cameras.",
};

/** Human label for the download tri-state used by the Users screen. */
export const DOWNLOAD_OVERRIDE_LABELS = {
  default: "Role default",
  allow: "Allow",
  deny: "Deny",
} as const;
export type DownloadOverride = keyof typeof DOWNLOAD_OVERRIDE_LABELS;

export function downloadOverrideOf(v: boolean | null | undefined): DownloadOverride {
  return v === true ? "allow" : v === false ? "deny" : "default";
}
