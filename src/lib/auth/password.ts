import bcrypt from "bcryptjs";
import { z } from "zod";

const ROUNDS = 12;

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password is too long")
  .refine((v) => /[a-z]/.test(v), "Password needs a lowercase letter")
  .refine((v) => /[A-Z]/.test(v), "Password needs an uppercase letter")
  .refine((v) => /\d/.test(v), "Password needs a number");

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
