import "server-only";
import { asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { cameras, stores, type Store } from "@/db/schema";
import { storeScope } from "@/lib/auth/rbac";
import type { SessionUser } from "@/lib/auth/session";

export type StoreRow = Store & { cameraCount: number; onlineCount: number };

export async function listStoresForUser(user: SessionUser): Promise<StoreRow[]> {
  const scope = storeScope(user);
  if (scope && scope.length === 0) return [];
  const rows = await db
    .select({
      store: stores,
      cameraCount: count(cameras.id),
      onlineCount: sql<number>`coalesce(sum(case when ${cameras.status} = 'ONLINE' then 1 else 0 end), 0)`,
    })
    .from(stores)
    .leftJoin(cameras, eq(cameras.storeId, stores.id))
    .where(scope ? inArray(stores.id, scope) : undefined)
    .groupBy(stores.id)
    .orderBy(asc(stores.name));
  return rows.map((r) => ({ ...r.store, cameraCount: Number(r.cameraCount), onlineCount: Number(r.onlineCount) }));
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
