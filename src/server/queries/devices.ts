import "server-only";
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { cameras, devices, stores, type Device, type Store } from "@/db/schema";
import { storeScope } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";

/** Device row without its secret: `passwordEnc` is replaced by the `hasPassword` flag. */
export type DeviceRow = Omit<Device, "passwordEnc"> & {
  hasPassword: boolean;
  store: Pick<Store, "id" | "name" | "code" | "kind" | "timezone">;
  cameraCount: number;
  onlineCameraCount: number;
};

export type DeviceOption = Pick<Device, "id" | "name" | "host" | "storeId" | "kind">;

export interface DeviceFilter {
  storeId?: string | null;
  search?: string | null;
  enabledOnly?: boolean;
}

const storeColumns = { id: stores.id, name: stores.name, code: stores.code, kind: stores.kind, timezone: stores.timezone };

/** Recorders visible to the user, with linked camera counts. Secrets are never returned. */
export async function listDevicesForUser(user: SessionUser, filter: DeviceFilter = {}): Promise<DeviceRow[]> {
  const scope = storeScope(user);
  if (scope && scope.length === 0) return [];

  const conditions: SQL[] = [];
  if (scope) conditions.push(inArray(devices.storeId, scope));
  if (filter.storeId) conditions.push(eq(devices.storeId, filter.storeId));
  if (filter.enabledOnly) conditions.push(eq(devices.isEnabled, true));
  if (filter.search) {
    const q = `%${filter.search.trim()}%`;
    const search = or(ilike(devices.name, q), ilike(devices.host, q), ilike(devices.model, q), ilike(devices.serialNumber, q), ilike(stores.name, q));
    if (search) conditions.push(search);
  }

  const rows = await db
    .select({
      device: devices,
      store: storeColumns,
      cameraCount: count(cameras.id),
      onlineCameraCount: sql<number>`coalesce(sum(case when ${cameras.status} = 'ONLINE' then 1 else 0 end), 0)`,
    })
    .from(devices)
    .innerJoin(stores, eq(devices.storeId, stores.id))
    .leftJoin(cameras, eq(cameras.deviceId, devices.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(devices.id, stores.id)
    .orderBy(asc(stores.name), asc(devices.name));

  return rows.map((r) => ({ ...stripSecret(r.device), store: r.store, cameraCount: Number(r.cameraCount), onlineCameraCount: Number(r.onlineCameraCount) }));
}

export async function getDeviceForUser(user: SessionUser, id: string): Promise<DeviceRow | null> {
  const scope = storeScope(user);
  if (scope && scope.length === 0) return null;
  const rows = await listDevicesForUser(user);
  return rows.find((d) => d.id === id) ?? null;
}

/** Lightweight list for selects (camera form, filters). */
export async function deviceOptionsForUser(user: SessionUser): Promise<DeviceOption[]> {
  const scope = storeScope(user);
  if (scope && scope.length === 0) return [];
  return db
    .select({ id: devices.id, name: devices.name, host: devices.host, storeId: devices.storeId, kind: devices.kind })
    .from(devices)
    .where(scope ? inArray(devices.storeId, scope) : undefined)
    .orderBy(asc(devices.name));
}

/** Raw device (with encrypted secret) for server-internal use only. */
export async function getDeviceInternal(id: string): Promise<Device | null> {
  return (await db.query.devices.findFirst({ where: eq(devices.id, id) })) ?? null;
}

function stripSecret(d: Device): Omit<Device, "passwordEnc"> & { hasPassword: boolean } {
  const { passwordEnc, ...rest } = d;
  return { ...rest, hasPassword: Boolean(passwordEnc) };
}
