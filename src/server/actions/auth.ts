"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { env } from "@/env";
import { users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { verifyPassword } from "@/lib/auth/password";
import { isLocked, recordFailure, recordSuccess } from "@/lib/auth/rate-limit";
import { clearSessionCookie, getCurrentUser, requestMeta, setSessionCookie, signSessionToken } from "@/lib/auth/session";
import { failure, parseForm, type ActionState } from "../action-utils";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
  next: z.string().optional(),
});

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(loginSchema, formData);
  if (!parsed.success) return parsed.state;
  const { email, password, next } = parsed.data;
  const { ip, userAgent } = await requestMeta();

  const keys = [`ip:${ip ?? "unknown"}`, `acct:${email}`];
  for (const key of keys) {
    const lock = isLocked(key);
    if (lock.locked) {
      return failure(`Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSeconds / 60)} minute(s).`);
    }
  }

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;

  if (!user || !valid || !user.isActive) {
    for (const key of keys) recordFailure(key);
    await audit({
      actorEmail: email,
      action: "auth.login_failed",
      entityType: "user",
      entityId: user?.id ?? null,
      details: { reason: !user ? "unknown_account" : !valid ? "bad_password" : "inactive" },
      ip,
      userAgent,
    });
    return failure("Invalid email or password.");
  }

  for (const key of keys) recordSuccess(key);
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const token = await signSessionToken(user);
  await setSessionCookie(token);
  await audit({ actor: { id: user.id, email: user.email }, action: "auth.login", entityType: "user", entityId: user.id, ip, userAgent });

  const target = safeNext(next);
  redirect(user.mustChangePassword ? "/profile?reason=change-password" : target);
}

/** Only same-origin paths are allowed after sign-in (blocks "//evil", "/\evil", control characters). */
function safeNext(next: string | undefined): string {
  // Backslashes (code 92) and control characters let browsers turn "/x" into "//host".
  const unsafeChar = [...(next ?? "")].some((ch) => {
    const code = ch.charCodeAt(0);
    return code === 92 || code < 32 || code === 127;
  });
  if (!next || !next.startsWith("/") || unsafeChar) return "/";
  try {
    const base = new URL(env.APP_URL);
    const url = new URL(next, base);
    return url.origin === base.origin ? `${url.pathname}${url.search}` : "/";
  } catch {
    return "/";
  }
}

export async function logoutAction(): Promise<void> {
  const user = await getCurrentUser();
  const { ip, userAgent } = await requestMeta();
  if (user) {
    await audit({ actor: { id: user.id, email: user.email }, action: "auth.logout", entityType: "user", entityId: user.id, ip, userAgent });
  }
  await clearSessionCookie();
  redirect("/login");
}
