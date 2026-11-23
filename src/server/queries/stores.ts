import "server-only";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { cameras, stores, type Store } from "@/db/schema";
import { deviceVendorId, oemGroupOf, recorderLinkState, summariseLinkStates, type LinkState, type OemGroup } from "@/components/health/connection-state";
import { cameraScopeFilter, storeScope } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";
import type { VendorId } from "@/lib/vendors";
import { listCamerasForUser } from "./cameras";
import { listDevicesForUser } from "./devices";

export type StoreRow = Store & { cameraCount: number; onlineCount: number };

/** Locations visible to the user with the cameras they may see (store assignment plus camera-level grants). */
export async function listStoresForUser(user: SessionUser): Promise<StoreRow[]> {
  const scope = storeScope(user);
  if (scope && scope.length === 0) return [];
  const camScope = cameraScopeFilter(user);
  const rows = await db
    .select({
      store: stores,
      cameraCount: count(cameras.id),
      onlineCount: sql<number>`coalesce(sum(case when ${cameras.status} = 'ONLINE' then 1 else 0 end), 0)`,
    })
    .from(stores)
    .leftJoin(cameras, (camScope ? and(eq(cameras.storeId, stores.id), camScope) : undefined) ?? eq(cameras.storeId, stores.id))
    .where(scope ? inArray(stores.id, scope) : undefined)
    .groupBy(stores.id)
    .orderBy(asc(stores.name));
  return rows.map((r) => ({ ...r.store, cameraCount: Number(r.cameraCount), onlineCount: Number(r.onlineCount) }));
}

export interface StoreEstateRow {
  id: string;
  code: string;
  name: string;
  kind: Store["kind"];
  address: string | null;
  city: string | null;
  region: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  notes: string | null;
  isActive: boolean;
  /** Vendors of the location's recorders, distinct, in a stable order. */
  vendors: VendorId[];
  oemGroups: OemGroup[];
  recorderCount: number;
  /** Recorders per connection state. */
  recorderStates: Partial<Record<LinkState, number>>;
  /** Worst-first summary of the location's recorders (an outage wins, then live, then "not connected yet"). */
  linkState: LinkState | "NONE";
  cameraCount: number;
  enabledCameraCount: number;
  onlineCount: number;
  offlineCount: number;
}

/**
 * Locations with their recorders' OEMs and connection state and the user's visible camera counts.
 * Recorders are store-scoped; cameras additionally honour camera-level grants.
 */
export async function listStoreEstateForUser(user: SessionUser): Promise<StoreEstateRow[]> {
  const scope = storeScope(user);
  if (scope && scope.length === 0) return [];
  const [storeRows, devs, cams] = await Promise.all([
    db
      .select()
      .from(stores)
      .where(scope ? inArray(stores.id, scope) : undefined)
      .orderBy(asc(stores.name)),
    listDevicesForUser(user),
    listCamerasForUser(user),
  ]);

  const rows = new Map<string, StoreEstateRow>(
    storeRows.map((s) => [
      s.id,
      {
        id: s.id,
        code: s.code,
        name: s.name,
        kind: s.kind,
        address: s.address,
        city: s.city,
        region: s.region,
        phone: s.phone,
        email: s.email,
        timezone: s.timezone,
        notes: s.notes,
        isActive: s.isActive,
        vendors: [],
        oemGroups: [],
        recorderCount: 0,
        recorderStates: {},
        linkState: "NONE",
        cameraCount: 0,
        enabledCameraCount: 0,
        onlineCount: 0,
        offlineCount: 0,
      },
    ]),
  );

  const states = new Map<string, LinkState[]>();
  for (const d of devs) {
    const row = rows.get(d.storeId);
    if (!row) continue;
    const state = recorderLinkState(d);
    const vendor = deviceVendorId(d);
    row.recorderCount += 1;
    row.recorderStates[state] = (row.recorderStates[state] ?? 0) + 1;
    if (!row.vendors.includes(vendor)) row.vendors.push(vendor);
    const group = oemGroupOf(vendor);
    if (!row.oemGroups.includes(group)) row.oemGroups.push(group);
    const list = states.get(d.storeId);
    if (list) list.push(state);
    else states.set(d.storeId, [state]);
  }
  for (const c of cams) {
    const row = rows.get(c.storeId);
    if (!row) continue;
    row.cameraCount += 1;
    if (!c.isEnabled) continue;
    row.enabledCameraCount += 1;
    if (c.status === "ONLINE") row.onlineCount += 1;
    else if (c.status === "OFFLINE") row.offlineCount += 1;
  }
  for (const row of rows.values()) row.linkState = summariseLinkStates(states.get(row.id) ?? []);

  return [...rows.values()];
}

/** Lightweight list for selects. */
export async function storeOptionsForUser(user: SessionUser): Promise<Array<Pick<Store, "id" | "name" | "code" | "kind">>> {
  const scope = storeScope(user);
  if (scope && scope.length === 0) return [];
  return db
    .select({ id: stores.id, name: stores.name, code: stores.code, kind: stores.kind })
    .from(stores)
    .where(scope ? inArray(stores.id, scope) : undefined)
    .orderBy(asc(stores.name));
}

export async function listAllStores(): Promise<Array<Pick<Store, "id" | "name" | "code" | "isActive">>> {
  return db.select({ id: stores.id, name: stores.name, code: stores.code, isActive: stores.isActive }).from(stores).orderBy(asc(stores.name));
}
