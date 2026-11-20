import "server-only";
import { and, asc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { cameras, devices, stores, type Camera, type Device, type Store } from "@/db/schema";
import { storeScope } from "@/lib/auth/rbac";
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
  const scope = storeScope(user);
  if (scope && scope.length === 0) return [];

  const conditions: SQL[] = [];
  if (scope) conditions.push(inArray(cameras.storeId, scope));
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

export async function getCameraForUser(user: SessionUser, id: string): Promise<CameraRow | null> {
  const row = await db.query.cameras.findFirst({
    where: eq(cameras.id, id),
    with: {
      store: { columns: { id: true, name: true, code: true, timezone: true } },
      device: { columns: { id: true, name: true, kind: true, host: true, rtspPort: true, status: true, isEnabled: true } },
    },
  });
  if (!row) return null;
  const scope = storeScope(user);
  if (scope && !scope.includes(row.storeId)) return null;
  const { store, device, ...camera } = row;
  return { ...stripSecret(camera), store, device: device ?? null };
}

/** Raw camera (with encrypted secret) for server-internal use only. */
export async function getCameraInternal(id: string): Promise<Camera | null> {
  return (await db.query.cameras.findFirst({ where: eq(cameras.id, id) })) ?? null;
}

function stripSecret<T extends Camera>(c: T): T {
  return { ...c, passwordEnc: c.passwordEnc ? "set" : null };
}
