"use server";

import { and, count, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { cameras, ROLES, stores, userCameras, userStores, users, type Role } from "@/db/schema";
import { audit } from "@/lib/audit";
import { hashPassword, passwordSchema } from "@/lib/auth/password";
import { rolesFor, type DownloadOverride } from "@/lib/auth/rbac";
import { loadSessionUser, requestMeta, requireUser } from "@/lib/auth/session";
import { closeUserPlaybackSessions, revokeLostStreamAccess } from "@/lib/mediamtx/revoke";
import { checkbox, failure, multiSelect, parseForm, success, type ActionState } from "../action-utils";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Repeated form field of ids; anything that is not a uuid is rejected before it reaches SQL. */
const idList = multiSelect.pipe(z.array(z.string().regex(UUID_RE, "Invalid selection")).max(5000));

const baseSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200),
  name: z.string().trim().min(2, "Name is required").max(120),
  role: z.enum(ROLES),
  storeIds: idList,
  /** Stores (subset of storeIds) limited to specific cameras instead of "all cameras of this location". */
  cameraLimitStores: idList,
  /** Cameras granted inside the limited stores. */
  cameraIds: idList,
  /** Footage download: role default / always allow / always deny. */
  allowDownload: z.enum(["default", "allow", "deny"]).optional().default("default"),
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

type AccessInput = Pick<z.infer<typeof baseSchema>, "role" | "storeIds" | "cameraLimitStores" | "cameraIds" | "allowDownload">;

interface ResolvedAccess {
  storeIds: string[];
  /** Stores (subset of storeIds) flagged user_stores.camera_limited. */
  limitedStoreIds: string[];
  /** Camera grants, all verified to belong to one of the user's limited stores. */
  cameraIds: string[];
  allowDownload: boolean | null;
}

function revalidate() {
  revalidatePath("/users");
}

const overrideToDb = (v: DownloadOverride): boolean | null => (v === "allow" ? true : v === "deny" ? false : null);

/**
 * Validates store and camera selections against the database. Camera grants
 * are only kept for cameras that really sit inside a store the user is being
 * assigned to (and that store was switched to "specific cameras").
 */
async function resolveAccess(d: AccessInput): Promise<{ ok: true; access: ResolvedAccess } | { ok: false; error: string }> {
  if (d.role === "ADMIN") return { ok: true, access: { storeIds: [], limitedStoreIds: [], cameraIds: [], allowDownload: null } };

  const storeIds = [...new Set(d.storeIds)];
  if (storeIds.length === 0) return { ok: false, error: "Assign at least one location to a store manager or viewer." };
  const known = await db.select({ id: stores.id, name: stores.name }).from(stores).where(inArray(stores.id, storeIds));
  if (known.length !== storeIds.length) return { ok: false, error: "One of the selected locations no longer exists. Reload and try again." };

  const assigned = new Set(storeIds);
  const limited = new Set(d.cameraLimitStores.filter((s) => assigned.has(s)));
  const requested = [...new Set(d.cameraIds)];
  const rows = requested.length && limited.size ? await db.select({ id: cameras.id, storeId: cameras.storeId }).from(cameras).where(inArray(cameras.id, requested)) : [];
  const cameraIds = rows.filter((r) => limited.has(r.storeId)).map((r) => r.id);

  const covered = new Set(rows.filter((r) => limited.has(r.storeId)).map((r) => r.storeId));
  const empty = known.filter((s) => limited.has(s.id) && !covered.has(s.id));
  if (empty.length > 0) {
    return { ok: false, error: `Pick at least one camera for ${empty.map((s) => s.name).join(", ")}, or switch it back to "All cameras".` };
  }
  return { ok: true, access: { storeIds, limitedStoreIds: [...limited], cameraIds, allowDownload: overrideToDb(d.allowDownload) } };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Replaces store and camera assignments for a user inside the caller's transaction. */
async function writeAssignments(tx: Tx, userId: string, role: Role, access: ResolvedAccess) {
  await tx.delete(userCameras).where(eq(userCameras.userId, userId));
  await tx.delete(userStores).where(eq(userStores.userId, userId));
  if (role === "ADMIN") return;
  const limited = new Set(access.limitedStoreIds);
  if (access.storeIds.length > 0) await tx.insert(userStores).values(access.storeIds.map((storeId) => ({ userId, storeId, cameraLimited: limited.has(storeId) })));
  if (access.cameraIds.length > 0) await tx.insert(userCameras).values(access.cameraIds.map((cameraId) => ({ userId, cameraId })));
}

function accessDetails(access: ResolvedAccess) {
  const download: DownloadOverride = access.allowDownload === true ? "allow" : access.allowDownload === false ? "deny" : "default";
  return { stores: access.storeIds.length, limitedStores: access.limitedStoreIds.length, cameras: access.cameraIds.length, download };
}

export async function createUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser(rolesFor("users.manage"));
  const parsed = parseForm(createSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;

  const exists = await db.query.users.findFirst({ where: eq(users.email, d.email) });
  if (exists) return failure("A user with this email already exists.");
  const resolved = await resolveAccess(d);
  if (!resolved.ok) return failure(resolved.error);
  const access = resolved.access;
  const passwordHash = await hashPassword(d.password);

  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(users)
      .values({
        email: d.email,
        name: d.name,
        role: d.role,
        passwordHash,
        isActive: d.isActive,
        mustChangePassword: d.mustChangePassword,
        allowDownload: access.allowDownload,
      })
      .returning({ id: users.id });
    if (!row) throw new Error("Could not create user.");
    await writeAssignments(tx, row.id, d.role, access);
    return row.id;
  });

  const meta = await requestMeta();
  await audit({ actor, action: "user.created", entityType: "user", entityId: id, entityLabel: d.email, details: { role: d.role, active: d.isActive, ...accessDetails(access) }, ...meta });
  revalidate();
  return success("User created", { id });
}

export async function updateUserAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const actor = await requireUser(rolesFor("users.manage"));
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return failure("User not found.");
  const parsed = parseForm(updateSchema, formData);
  if (!parsed.success) return parsed.state;
  const d = parsed.data;

  const current = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!current) return failure("User not found.");
  const clash = await db.query.users.findFirst({ where: and(eq(users.email, d.email), ne(users.id, id)) });
  if (clash) return failure("Another user already has this email.");

  if (current.id === actor.id && (d.role !== "ADMIN" || !d.isActive)) {
    return failure("You cannot remove your own administrator access or deactivate yourself.");
  }
  if (current.role === "ADMIN" && (d.role !== "ADMIN" || !d.isActive)) {
    const [c] = await db.select({ n: count() }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.isActive, true), ne(users.id, id)));
    if ((c?.n ?? 0) === 0) return failure("At least one active administrator must remain.");
  }
  const resolved = await resolveAccess(d);
  if (!resolved.ok) return failure(resolved.error);
  const access = resolved.access;

  // Compare with what is stored to record whether access actually changed.
  const [prevStores, prevCameras] = await Promise.all([
    db.select({ id: userStores.storeId, cameraLimited: userStores.cameraLimited }).from(userStores).where(eq(userStores.userId, id)),
    db.select({ id: userCameras.cameraId }).from(userCameras).where(eq(userCameras.userId, id)),
  ]);
  const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length;
  const locationsChanged = !sameSet(prevStores.map((r) => r.id), access.storeIds);
  const camerasChanged =
    !sameSet(prevCameras.map((r) => r.id), access.cameraIds) ||
    !sameSet(prevStores.filter((r) => r.cameraLimited).map((r) => r.id), access.limitedStoreIds);
  const downloadChanged = (current.allowDownload ?? null) !== access.allowDownload;

  const roleOrAccessChanged = current.role !== d.role || current.isActive !== d.isActive;
  const passwordHash = d.password ? await hashPassword(d.password) : null;
  const before = await loadSessionUser(id);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        email: d.email,
        name: d.name,
        role: d.role,
        isActive: d.isActive,
        allowDownload: access.allowDownload,
        mustChangePassword: d.password ? true : d.mustChangePassword,
        ...(passwordHash ? { passwordHash } : {}),
        // Force re-login when privileges change or the password is reset.
        // Location/camera/download changes need no re-login: the session is re-read on every
        // request, and MediaMTX re-checks stream tokens against current access (HLS segments and
        // recording downloads per request, cached up to 30 s). WebRTC/RTSP readers are only
        // authorised at connect time, so they are disconnected below (revokeLostStreamAccess).
        ...(roleOrAccessChanged || d.password ? { tokenVersion: current.tokenVersion + 1 } : {}),
      })
      .where(eq(users.id, id));
    await writeAssignments(tx, id, d.role, access);
  });
  const revoked = await revokeLostStreamAccess(before, await loadSessionUser(id)).catch((e: unknown) => {
    console.warn(`[users] stream access revocation failed: ${(e as Error).message}`);
    return null;
  });

  const meta = await requestMeta();
  await audit({
    actor,
    action: d.password ? "user.password_reset" : "user.updated",
    entityType: "user",
    entityId: id,
    entityLabel: d.email,
    details: { role: d.role, active: d.isActive, roleChanged: current.role !== d.role, ...accessDetails(access), locationsChanged, camerasChanged, downloadChanged, ...(revoked?.cameras ? { streamsRevoked: revoked } : {}) },
    ...meta,
  });
  revalidate();
  return success("User updated");
}

export async function deleteUserAction(id: string): Promise<ActionState> {
  const actor = await requireUser(rolesFor("users.manage"));
  if (!UUID_RE.test(id)) return failure("User not found.");
  if (id === actor.id) return failure("You cannot delete your own account.");
  const current = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!current) return failure("User not found.");
  if (current.role === "ADMIN") {
    const [c] = await db.select({ n: count() }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.isActive, true), ne(users.id, id)));
    if ((c?.n ?? 0) === 0) return failure("At least one active administrator must remain.");
  }
  const before = await loadSessionUser(id);
  // Sessions lose their owner on delete, so close them first; live readers are kicked after the delete.
  await closeUserPlaybackSessions(id).catch(() => 0);
  await db.delete(users).where(eq(users.id, id));
  await revokeLostStreamAccess(before, null).catch((e: unknown) => console.warn(`[users] stream access revocation failed: ${(e as Error).message}`));
  const meta = await requestMeta();
  await audit({ actor, action: "user.deleted", entityType: "user", entityId: id, entityLabel: current.email, details: { role: current.role }, ...meta });
  revalidate();
  return success("User deleted");
}
