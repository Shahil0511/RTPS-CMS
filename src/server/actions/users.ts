"use server";

import { and, count, eq, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { ROLES, userStores, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { rolesFor } from "@/lib/auth/rbac";
import { requestMeta, requireUser } from "@/lib/auth/session";
import { checkbox, failure, multiSelect, parseForm, success, type ActionState } from "../action-utils";

const baseSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200),
  name: z.string().trim().min(2, "Name is required").max(120),
  role: z.enum(ROLES),
  storeIds: multiSelect,
  isActive: checkbox,
  mustChangePassword: checkbox,
});

const createSchema = baseSchema.extend({ password: passwordSchema });
const updateSchema = baseSchema.extend({
  password: z
    .string()
    .optional()
    .default("")
    .refine((v) => v === "" || passwordSchema.safeParse(v).success, "Password must be 10+ characters with upper, lower case and a number"),
});

function revalidate() {
  revalidatePath("/users");
}

async function replaceStoreAssignments(userId: string, role: string, storeIds: string[]) {
  await db.delete(userStores).where(eq(userStores.userId, userId));
  if (role !== "ADMIN" && storeIds.length > 0) {
    await db.insert(userStores).values(storeIds.map((storeId) => ({ userId, storeId })));
  }
}

export async function createUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser(rolesFor("users.manage"));
  const parsed = parseForm(createSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;

  const exists = await db.query.users.findFirst({ where: eq(users.email, d.email) });
  if (exists) return failure("A user with this email already exists.");
  if (d.role !== "ADMIN" && d.storeIds.length === 0) return failure("Assign at least one store to a manager or viewer.");

  const [row] = await db
    .insert(users)
    .values({
      email: d.email,
      name: d.name,
      role: d.role,
      passwordHash: await hashPassword(d.password),
      isActive: d.isActive,
      mustChangePassword: d.mustChangePassword,
    })
    .returning({ id: users.id });
  if (!row) return failure("Could not create user.");
  await replaceStoreAssignments(row.id, d.role, d.storeIds);

  const meta = await requestMeta();
  await audit({ actor, action: "user.created", entityType: "user", entityId: row.id, entityLabel: d.email, details: { role: d.role, stores: d.storeIds.length, active: d.isActive }, ...meta });
  revalidate();
  return success("User created", { id: row.id });
}

export async function updateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser(rolesFor("users.manage"));
  const id = String(formData.get("id") ?? "");
  const parsed = parseForm(updateSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;

  const current = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!current) return failure("User not found.");
  const clash = await db.query.users.findFirst({ where: and(eq(users.email, d.email), ne(users.id, id)) });
  if (clash) return failure("Another user already has this email.");
  if (d.role !== "ADMIN" && d.storeIds.length === 0) return failure("Assign at least one store to a manager or viewer.");

  if (current.id === actor.id && (d.role !== "ADMIN" || !d.isActive)) {
    return failure("You cannot remove your own administrator access or deactivate yourself.");
  }
  if (current.role === "ADMIN" && (d.role !== "ADMIN" || !d.isActive)) {
    const [c] = await db.select({ n: count() }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.isActive, true), ne(users.id, id)));
    if ((c?.n ?? 0) === 0) return failure("At least one active administrator must remain.");
  }

  const roleOrAccessChanged = current.role !== d.role || current.isActive !== d.isActive;
  await db
    .update(users)
    .set({
      email: d.email,
      name: d.name,
      role: d.role,
      isActive: d.isActive,
      mustChangePassword: d.password ? true : d.mustChangePassword,
      ...(d.password ? { passwordHash: await hashPassword(d.password) } : {}),
      // Force re-login when privileges change or the password is reset.
      ...(roleOrAccessChanged || d.password ? { tokenVersion: current.tokenVersion + 1 } : {}),
    })
    .where(eq(users.id, id));
  await replaceStoreAssignments(id, d.role, d.storeIds);

  const meta = await requestMeta();
  await audit({ actor, action: d.password ? "user.password_reset" : "user.updated", entityType: "user", entityId: id, entityLabel: d.email, details: { role: d.role, stores: d.storeIds.length, active: d.isActive, roleChanged: current.role !== d.role }, ...meta });
  revalidate();
  return success("User updated");
}

export async function deleteUserAction(id: string): Promise<ActionState> {
  const actor = await requireUser(rolesFor("users.manage"));
  if (id === actor.id) return failure("You cannot delete your own account.");
  const current = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!current) return failure("User not found.");
  if (current.role === "ADMIN") {
    const [c] = await db.select({ n: count() }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.isActive, true), ne(users.id, id)));
    if ((c?.n ?? 0) === 0) return failure("At least one active administrator must remain.");
  }
  await db.delete(users).where(eq(users.id, id));
  const meta = await requestMeta();
  await audit({ actor, action: "user.deleted", entityType: "user", entityId: id, entityLabel: current.email, details: { role: current.role }, ...meta });
  revalidate();
  return success("User deleted");
}
