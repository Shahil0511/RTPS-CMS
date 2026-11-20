import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { stores, userStores, users, type Role } from "@/db/schema";

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
}

export async function listUsers(): Promise<UserRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.name));

  const assignments = await db
    .select({ userId: userStores.userId, id: stores.id, name: stores.name, code: stores.code })
    .from(userStores)
    .innerJoin(stores, eq(stores.id, userStores.storeId));

  const byUser = new Map<string, UserRow["stores"]>();
  for (const a of assignments) {
    const list = byUser.get(a.userId) ?? [];
    list.push({ id: a.id, name: a.name, code: a.code });
    byUser.set(a.userId, list);
  }
  return rows.map((r) => ({ ...r, stores: byUser.get(r.id) ?? [] }));
}

export async function getUserRow(id: string): Promise<UserRow | null> {
  const all = await listUsers();
  return all.find((u) => u.id === id) ?? null;
}
