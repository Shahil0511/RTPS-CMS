import { z } from "zod";

export interface ActionState {
  ok: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  /** Optional payload returned to the caller (e.g. created id). */
  data?: Record<string, unknown>;
}

export const idle: ActionState = { ok: false };

/** Converts FormData to a plain object; repeated keys become arrays; "on" checkboxes become booleans. */
export function formToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("$ACTION")) continue;
    const v = typeof value === "string" ? value : value.name;
    if (key.endsWith("[]")) {
      const k = key.slice(0, -2);
      const arr = (out[k] as string[] | undefined) ?? [];
      arr.push(v);
      out[k] = arr;
    } else if (key in out) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else {
      out[key] = v;
    }
  }
  return out;
}

export function parseForm<T extends z.ZodTypeAny>(
  schema: T,
  formData: FormData,
): { success: true; data: z.infer<T> } | { success: false; state: ActionState } {
  const result = schema.safeParse(formToObject(formData));
  if (result.success) return { success: true, data: result.data };
  const flat = z.flattenError(result.error);
  const first = Object.values(flat.fieldErrors).flat().find(Boolean) ?? flat.formErrors[0] ?? "Invalid input";
  return {
    success: false,
    state: { ok: false, error: String(first), fieldErrors: flat.fieldErrors as Record<string, string[] | undefined> },
  };
}

export function failure(error: string): ActionState {
  return { ok: false, error };
}

export function success(message: string, data?: Record<string, unknown>): ActionState {
  return { ok: true, message, data };
}

/** Zod helpers shared by forms. */
export const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0"), z.literal("")])
  .optional()
  .transform((v) => v === "on" || v === "true" || v === "1");

export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const multiSelect = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter(Boolean));
