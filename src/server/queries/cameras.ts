import "server-only";
import { and, asc, eq, ilike, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { cameras, devices, stores, type Camera, type Device, type Store } from "@/db/schema";
import { canAccessCamera, cameraScopeFilter } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";

export type CameraDeviceRef = Pick<Device, "id" | "name" | "kind" | "host" | "rtspPort" | "status" | "isEnabled">;
export type CameraRow = Camera & { store: Pick<Store, "id" | "name" | "code" | "timezone">; device: CameraDeviceRef | null };

export interface CameraFilter {
  storeId?: string | null;
  deviceId?: string | null;
  search?: string | null;
  enabledOnly?: boolean;
}

const deviceColumns = { id: devices.id, name: devices.name, kind: devices.kind, host: devices.host, rtspPort: devices.rtspPort, status: devices.status, isEnabled: devices.isEnabled };

/** Cameras visible to the user, optionally filtered. Secrets are never returned. */
export async function listCamerasForUser(user: SessionUser, filter: CameraFilter = {}): Promise<CameraRow[]> {
  if (!user.isAdmin && user.storeIds.length === 0) return [];

  const conditions: SQL[] = [];
  // Store assignment plus any camera-level restriction (vms.user_cameras).
  const scope = cameraScopeFilter(user);
  if (scope) conditions.push(scope);
  if (filter.storeId) conditions.push(eq(cameras.storeId, filter.storeId));
  if (filter.deviceId) conditions.push(eq(cameras.deviceId, filter.deviceId));
  if (filter.enabledOnly) conditions.push(eq(cameras.isEnabled, true));
  if (filter.search) {
    const q = `%${filter.search.trim()}%`;
    const search = or(ilike(cameras.name, q), ilike(cameras.host, q), ilike(cameras.pathName, q), ilike(stores.name, q), ilike(devices.name, q), ilike(devices.host, q));
    if (search) conditions.push(search);
  }

  const rows = await db
    .select({ camera: cameras, store: { id: stores.id, name: stores.name, code: stores.code, timezone: stores.timezone }, device: deviceColumns })
    .from(cameras)
    .innerJoin(stores, eq(cameras.storeId, stores.id))
    .leftJoin(devices, eq(cameras.deviceId, devices.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(stores.name), asc(cameras.sortOrder), asc(cameras.name));

  return rows.map((r) => ({ ...stripSecret(r.camera), store: r.store, device: r.device?.id ? r.device : null }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getCameraForUser(user: SessionUser, id: string): Promise<CameraRow | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await db.query.cameras.findFirst({
    where: eq(cameras.id, id),
    with: {
      store: { columns: { id: true, name: true, code: true, timezone: true } },
      device: { columns: { id: true, name: true, kind: true, host: true, rtspPort: true, status: true, isEnabled: true } },
    },
  });
  // Same "not found" for a missing camera and one the user may not open (no enumeration).
  if (!row || !canAccessCamera(user, row)) return null;
  const { store, device, ...camera } = row;
  return { ...stripSecret(camera), store, device: device ?? null };
}

export interface CameraOption {
  id: string;
  name: string;
  storeId: string;
  channel: number | null;
  deviceName: string | null;
  isEnabled: boolean;
}

/**
 * Every camera as a lightweight option list (no secrets, no addresses), used
 * by the Users screen to assign cameras. Admin-only callers.
 */
export async function listCameraOptions(): Promise<CameraOption[]> {
  return db
    .select({ id: cameras.id, name: cameras.name, storeId: cameras.storeId, channel: cameras.channel, deviceName: devices.name, isEnabled: cameras.isEnabled })
    .from(cameras)
    .leftJoin(devices, eq(cameras.deviceId, devices.id))
    .orderBy(asc(cameras.storeId), asc(cameras.sortOrder), asc(cameras.name));
}

/** Raw camera (with encrypted secret) for server-internal use only. */
export async function getCameraInternal(id: string): Promise<Camera | null> {
  return (await db.query.cameras.findFirst({ where: eq(cameras.id, id) })) ?? null;
}

function stripSecret<T extends Camera>(c: T): T {
  return { ...c, passwordEnc: c.passwordEnc ? "set" : null };
}
