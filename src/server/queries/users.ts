import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { cameras, stores, userCameras, userStores, users, type Role } from "@/db/schema";
import { can } from "@/lib/auth/rbac";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  stores: Array<{ id: string; name: string; code: string }>;
  /** Per-user download override: null = role default. */
  allowDownload: boolean | null;
  /** Effective download right (override, else role "playback.export"). */
  canDownload: boolean;
  /** Assigned stores flagged user_stores.camera_limited ("specific cameras" only). */
  limitedStoreIds: string[];
  /** Camera-level grants, only for cameras inside the user's camera-limited stores. */
  cameraIds: string[];
  /** Number of assigned stores that are limited to specific cameras. */
  restrictedStoreCount: number;
}

export async function listUsers(): Promise<UserRow[]> {
  const [rows, assignments, grants] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        isActive: users.isActive,
        mustChangePassword: users.mustChangePassword,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        allowDownload: users.allowDownload,
      })
      .from(users)
      .orderBy(asc(users.name)),
    db
      .select({ userId: userStores.userId, id: stores.id, name: stores.name, code: stores.code, cameraLimited: userStores.cameraLimited })
      .from(userStores)
      .innerJoin(stores, eq(stores.id, userStores.storeId))
      .orderBy(asc(stores.name)),
    db
      .select({ userId: userCameras.userId, cameraId: userCameras.cameraId, storeId: cameras.storeId })
      .from(userCameras)
      .innerJoin(cameras, eq(cameras.id, userCameras.cameraId)),
  ]);

  const byUser = new Map<string, UserRow["stores"]>();
  const limitedByUser = new Map<string, Set<string>>();
  for (const a of assignments) {
    const list = byUser.get(a.userId) ?? [];
    list.push({ id: a.id, name: a.name, code: a.code });
    byUser.set(a.userId, list);
    if (a.cameraLimited) {
      const set = limitedByUser.get(a.userId) ?? new Set<string>();
      set.add(a.id);
      limitedByUser.set(a.userId, set);
    }
  }
  const grantsByUser = new Map<string, Array<{ cameraId: string; storeId: string }>>();
  for (const g of grants) {
    const list = grantsByUser.get(g.userId) ?? [];
    list.push(g);
    grantsByUser.set(g.userId, list);
  }

  return rows.map((r) => {
    const isAdmin = r.role === "ADMIN";
    const userStoresList = byUser.get(r.id) ?? [];
    const limited = isAdmin ? new Set<string>() : (limitedByUser.get(r.id) ?? new Set<string>());
    // Mirror loadSessionUser: grants only count inside camera-limited stores.
    const effective = isAdmin ? [] : (grantsByUser.get(r.id) ?? []).filter((g) => limited.has(g.storeId));
    const allowDownload = isAdmin ? null : (r.allowDownload ?? null);
    return {
      ...r,
      allowDownload,
      canDownload: allowDownload ?? can({ role: r.role }, "playback.export"),
      stores: userStoresList,
      limitedStoreIds: [...limited],
      cameraIds: effective.map((g) => g.cameraId),
      restrictedStoreCount: limited.size,
    };
  });
}

export async function getUserRow(id: string): Promise<UserRow | null> {
  const all = await listUsers();
  return all.find((u) => u.id === id) ?? null;
}
