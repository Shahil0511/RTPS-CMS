"use server";

import { count, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { cameras, devices, SITE_KINDS, stores } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requestMeta, requireUser } from "@/lib/auth/session";
import { rolesFor } from "@/lib/auth/rbac";
import { checkbox, failure, optionalText, parseForm, success, type ActionState } from "../action-utils";

const storeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, "Code must be 2-12 characters")
    .max(12, "Code must be 2-12 characters")
    .regex(/^[A-Z0-9-]+$/, "Code may contain letters, numbers and dashes only"),
  name: z.string().trim().min(2, "Name is required").max(120),
  kind: z.enum(SITE_KINDS).default("STORE"),
  address: optionalText(300),
  city: optionalText(80),
  region: optionalText(80),
  phone: optionalText(40),
  /** Store mailbox: offered as an alert recipient for this location. Empty clears it. */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || z.email().safeParse(v).success, "Enter a valid email address"),
  timezone: z.string().trim().min(1).max(64).default("Asia/Kolkata"),
  notes: optionalText(1000),
  isActive: checkbox,
});

function revalidate() {
  revalidatePath("/stores");
  revalidatePath("/cameras");
  revalidatePath("/");
}

export async function createStoreAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser(rolesFor("stores.manage"));
  const parsed = parseForm(storeSchema, formData);
  if (!parsed.success) return parsed.state;

  const exists = await db.query.stores.findFirst({ where: eq(stores.code, parsed.data.code) });
  if (exists) return failure(`Store code ${parsed.data.code} is already in use.`);

  const [row] = await db.insert(stores).values(parsed.data).returning({ id: stores.id });
  const meta = await requestMeta();
  await audit({ actor: user, action: "store.created", entityType: "store", entityId: row?.id, entityLabel: parsed.data.name, details: { code: parsed.data.code }, ...meta });
  revalidate();
  return success("Store created", { id: row?.id });
}

export async function updateStoreAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireUser(rolesFor("stores.manage"));
  const id = String(formData.get("id") ?? "");
  const parsed = parseForm(storeSchema, formData);
  if (!parsed.success) return parsed.state;

  const current = await db.query.stores.findFirst({ where: eq(stores.id, id) });
  if (!current) return failure("Store not found.");
  const clash = await db.query.stores.findFirst({ where: eq(stores.code, parsed.data.code) });
  if (clash && clash.id !== id) return failure(`Store code ${parsed.data.code} is already in use.`);

  await db.update(stores).set(parsed.data).where(eq(stores.id, id));
  const meta = await requestMeta();
  await audit({ actor: user, action: "store.updated", entityType: "store", entityId: id, entityLabel: parsed.data.name, details: diff(current, parsed.data), ...meta });
  revalidate();
  return success("Store updated");
}

export async function deleteStoreAction(id: string): Promise<ActionState> {
  const user = await requireUser(rolesFor("stores.manage"));
  const current = await db.query.stores.findFirst({ where: eq(stores.id, id) });
  if (!current) return failure("Store not found.");
  const [[c], [r]] = await Promise.all([
    db.select({ n: count() }).from(cameras).where(eq(cameras.storeId, id)),
    db.select({ n: count() }).from(devices).where(eq(devices.storeId, id)),
  ]);
  if ((c?.n ?? 0) > 0) return failure(`Cannot delete: ${c?.n} camera(s) are still assigned to this location.`);
  if ((r?.n ?? 0) > 0) return failure(`Cannot delete: ${r?.n} recorder(s) are still assigned to this location. Delete or move them first.`);

  await db.delete(stores).where(eq(stores.id, id));
  const meta = await requestMeta();
  await audit({ actor: user, action: "store.deleted", entityType: "store", entityId: id, entityLabel: current.name, details: { code: current.code }, ...meta });
  revalidate();
  return success("Store deleted");
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (k in before && before[k] !== v) changes[k] = { from: before[k], to: v };
  }
  return changes;
}
