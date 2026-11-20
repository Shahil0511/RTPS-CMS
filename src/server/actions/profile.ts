"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";
import { requestMeta, requireUser, setSessionCookie, signSessionToken } from "@/lib/auth/session";
import { failure, parseForm, success, type ActionState } from "../action-utils";

const schema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, { message: "Passwords do not match", path: ["confirmPassword"] })
  .refine((d) => d.newPassword !== d.currentPassword, { message: "Choose a different password", path: ["newPassword"] });

export async function changePasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser();
  const parsed = parseForm(schema, formData);
  if (!parsed.success) return parsed.state;

  const row = await db.query.users.findFirst({ where: eq(users.id, actor.id) });
  if (!row) return failure("Account not found.");
  if (!(await verifyPassword(parsed.data.currentPassword, row.passwordHash))) {
    return failure("Current password is incorrect.");
  }

  const tokenVersion = row.tokenVersion + 1;
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(parsed.data.newPassword), mustChangePassword: false, tokenVersion })
    .where(eq(users.id, actor.id));

  // Other sessions are invalidated by the version bump; keep this one alive.
  await setSessionCookie(await signSessionToken({ ...row, tokenVersion, mustChangePassword: false }));

  const meta = await requestMeta();
  await audit({ actor, action: "auth.password_changed", entityType: "user", entityId: actor.id, entityLabel: actor.email, ...meta });
  return success("Password updated. Other devices have been signed out.");
}
