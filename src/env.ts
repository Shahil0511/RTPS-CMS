import { z } from "zod";

/**
 * Validated server-side environment. Imported only from server code.
 * Fails fast at boot with a readable message instead of failing later in a request.
 */
/** Treats blank values (e.g. "SMTP_HOST=" in .env) as unset. */
/** True for a timezone the runtime's Intl knows (an invalid one would otherwise break every alert email). */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function emptyToUndefined(v: unknown): unknown {
  return typeof v === "string" && v.trim() === "" ? undefined : v;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL must be a postgres:// URL"),
  DATABASE_SCHEMA: z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/, "DATABASE_SCHEMA must be a simple lowercase identifier")
    .default("vms"),
  PGSSL: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters")
    .refine((v) => !v.startsWith("change-me"), "SESSION_SECRET must be changed from the example value"),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be 64 hex characters (32 bytes)"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),

  MEDIAMTX_API_URL: z.string().url().default("http://127.0.0.1:9997"),
  MEDIAMTX_PLAYBACK_URL: z.string().url().default("http://127.0.0.1:9996"),
  MEDIAMTX_PUBLIC_WEBRTC_URL: z.string().url().default("http://localhost:8889"),
  MEDIAMTX_PUBLIC_HLS_URL: z.string().url().default("http://localhost:8888"),
  MEDIAMTX_API_USER: z.string().min(1).default("vms-service"),
  MEDIAMTX_API_PASS: z.string().min(8, "MEDIAMTX_API_PASS must be at least 8 characters"),
  /** Shared secret in MediaMTX's auth URL (?k=...), so only MediaMTX can call the auth hook. */
  MEDIAMTX_AUTH_SECRET: z.string().min(16, "MEDIAMTX_AUTH_SECRET must be at least 16 characters"),

  RECORDING_ROOT: z.string().min(1).default("./recordings"),
  DEFAULT_RECORD_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  DEFAULT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(7),
  RECORD_SEGMENT_MINUTES: z.coerce.number().int().min(1).max(240).default(15),

  /** Pull live video from recorders only while someone is watching (strongly recommended for NVRs). */
  LIVE_ON_DEMAND: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  /** Longest single NVR playback request, in minutes. */
  NVR_PLAYBACK_MAX_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(180),
  /** Send "Range: clock=<start>-" on PLAY (Hikvision spec); disable if a recorder rejects it. */
  NVR_PLAYBACK_RANGE_HEADER: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  HEALTH_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(20),
  HEALTH_TCP_TIMEOUT_MS: z.coerce.number().int().min(200).max(30000).default(3000),

  ADMIN_EMAIL: z.string().email().default("admin@libas.in"),
  ADMIN_PASSWORD: z.string().min(8).default("ChangeMe123!"),
  ADMIN_NAME: z.string().min(1).default("System Administrator"),
  SEED_CAMERA_FILE: z.string().optional(),

  /** Outgoing mail for alerts and reports. All optional: without SMTP_HOST, emails are kept in the outbox as SKIPPED_NO_SMTP. */
  SMTP_HOST: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  SMTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(587)),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes"),
  SMTP_USER: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_PASS: z.preprocess(emptyToUndefined, z.string().optional()),
  SMTP_FROM: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  /** Timezone used for alert timestamps and the daily report window. */
  ALERT_TIMEZONE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .trim()
      .min(1)
      .default("Asia/Kolkata")
      .refine(isValidTimeZone, { message: "must be an IANA timezone such as Asia/Kolkata (alert times and the daily report use it)" }),
  ),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\nSee .env.example for the expected values.`);
  }
  return parsed.data;
}

declare global {
  // eslint-disable-next-line no-var
  var __vmsEnv: Env | undefined;
}

export const env: Env = globalThis.__vmsEnv ?? (globalThis.__vmsEnv = load());

export const isProd = env.NODE_ENV === "production";
