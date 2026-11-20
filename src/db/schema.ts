import { relations } from "drizzle-orm";
import { boolean, index, integer, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Every VMS table lives in its own PostgreSQL schema (default "vms") so the
 * application can share a database server without touching other data.
 */
export const SCHEMA_NAME = process.env.DATABASE_SCHEMA?.trim() || "vms";
export const vms = pgSchema(SCHEMA_NAME);

export const ROLES = ["ADMIN", "MANAGER", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

export const CAMERA_STATUSES = ["ONLINE", "OFFLINE", "UNKNOWN"] as const;
export type CameraStatus = (typeof CAMERA_STATUSES)[number];

export const RTSP_TRANSPORTS = ["tcp", "udp", "automatic"] as const;
export type RtspTransport = (typeof RTSP_TRANSPORTS)[number];

/** Location categories: STORE sites appear under the "Stores" tab; CORPORATE and WAREHOUSE under "Corporate". */
export const SITE_KINDS = ["STORE", "CORPORATE", "WAREHOUSE"] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

export const DEVICE_KINDS = ["NVR", "DVR", "CAMERA"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Where playback comes from: the recorder's own disks (NVR), MediaMTX local recording (LOCAL) or nowhere. */
export const PLAYBACK_MODES = ["NVR", "LOCAL", "NONE"] as const;
export type PlaybackMode = (typeof PLAYBACK_MODES)[number];

export const roleEnum = vms.enum("user_role", ROLES);
export const cameraStatusEnum = vms.enum("camera_status", CAMERA_STATUSES);
export const rtspTransportEnum = vms.enum("rtsp_transport", RTSP_TRANSPORTS);
export const siteKindEnum = vms.enum("site_kind", SITE_KINDS);
export const deviceKindEnum = vms.enum("device_kind", DEVICE_KINDS);
export const playbackModeEnum = vms.enum("playback_mode", PLAYBACK_MODES);

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date());
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = vms.table(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: roleEnum("role").notNull().default("VIEWER"),
    isActive: boolean("is_active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** Incremented to invalidate every existing session of the user. */
    tokenVersion: integer("token_version").notNull().default(0),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

/** Sites: retail stores plus corporate offices and warehouses. */
export const stores = vms.table(
  "stores",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: siteKindEnum("kind").notNull().default("STORE"),
    address: text("address"),
    city: text("city"),
    region: text("region"),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    phone: text("phone"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("stores_code_idx").on(t.code), index("stores_kind_idx").on(t.kind)],
);

export const userStores = vms.table(
  "user_stores",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.storeId] })],
);

/** Recorders (NVR/DVR) or standalone cameras that own channels, credentials and recordings. */
export const devices = vms.table(
  "devices",
  {
    id: id(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: deviceKindEnum("kind").notNull().default("NVR"),
    vendor: text("vendor").notNull().default("hikvision"),
    host: text("host").notNull(),
    httpPort: integer("http_port").notNull().default(80),
    httpsEnabled: boolean("https_enabled").notNull().default(false),
    rtspPort: integer("rtsp_port").notNull().default(554),
    username: text("username"),
    /** AES-256-GCM encrypted. */
    passwordEnc: text("password_enc"),
    channelCount: integer("channel_count"),
    model: text("model"),
    serialNumber: text("serial_number"),
    firmware: text("firmware"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    notes: text("notes"),

    status: cameraStatusEnum("status").notNull().default("UNKNOWN"),
    lastOnlineAt: ts("last_online_at"),
    lastCheckedAt: ts("last_checked_at"),
    lastError: text("last_error"),
    lastLatencyMs: integer("last_latency_ms"),
    /** Recording health reported by the recorder (e.g. HDD status), free text. */
    storageStatus: text("storage_status"),
    /** Total / free recorder disk space in MB, read via ISAPI. */
    storageTotalMb: integer("storage_total_mb"),
    storageFreeMb: integer("storage_free_mb"),
    /**
     * How the recorder interprets the "Z" timestamps of ISAPI search and RTSP playback.
     * "local": the value is the recorder's wall clock (most Hikvision NVRs); "utc": true UTC (per spec).
     */
    timeMode: text("time_mode").notNull().default("local"),
    /** Recorder UTC offset in minutes (e.g. 330 for IST). Null = read from the recorder, else the site timezone. */
    utcOffsetMinutes: integer("utc_offset_minutes"),
    /** Detected clock error: recorder clock minus real time, in seconds (positive = recorder is fast). */
    clockDriftSeconds: integer("clock_drift_seconds"),
    /** Last time model/serial/storage were read from the recorder. */
    infoCheckedAt: ts("info_checked_at"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("devices_store_idx").on(t.storeId), uniqueIndex("devices_host_port_idx").on(t.host, t.rtspPort)],
);

export const deviceStatusEvents = vms.table(
  "device_status_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    status: cameraStatusEnum("status").notNull(),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("device_status_events_device_time_idx").on(t.deviceId, t.createdAt)],
);

export const cameras = vms.table(
  "cameras",
  {
    id: id(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    /** MediaMTX path name. Unique, URL-safe. */
    pathName: text("path_name").notNull(),
    description: text("description"),
    /** Recorder that owns this channel. When set, host/port/credentials come from the device. */
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    /** Channel number on the recorder (1 = /Streaming/Unicast/channels/101). */
    channel: integer("channel"),
    /** Direct-connection fields, used when no device is linked. */
    host: text("host"),
    port: integer("port").notNull().default(554),
    username: text("username"),
    /** AES-256-GCM encrypted. */
    passwordEnc: text("password_enc"),
    rtspPath: text("rtsp_path").notNull().default("/"),
    transport: rtspTransportEnum("transport").notNull().default("tcp"),
    playbackMode: playbackModeEnum("playback_mode").notNull().default("NVR"),
    /** Local recording through MediaMTX (optional; the recorder normally keeps the footage). */
    recordEnabled: boolean("record_enabled").notNull().default(false),
    retentionDays: integer("retention_days").notNull().default(7),
    isEnabled: boolean("is_enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),

    status: cameraStatusEnum("status").notNull().default("UNKNOWN"),
    lastOnlineAt: ts("last_online_at"),
    lastCheckedAt: ts("last_checked_at"),
    lastError: text("last_error"),
    lastLatencyMs: integer("last_latency_ms"),
    videoCodec: text("video_codec"),
    audioCodec: text("audio_codec"),
    resolution: text("resolution"),
    readerCount: integer("reader_count").notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("cameras_path_name_idx").on(t.pathName),
    index("cameras_store_idx").on(t.storeId),
    index("cameras_status_idx").on(t.status),
    index("cameras_device_idx").on(t.deviceId),
  ],
);

export const cameraStatusEvents = vms.table(
  "camera_status_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    status: cameraStatusEnum("status").notNull(),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("camera_status_events_camera_time_idx").on(t.cameraId, t.createdAt)],
);

/** Short-lived MediaMTX paths that proxy a recorder's playback stream to one viewer. */
export const playbackSessions = vms.table(
  "playback_sessions",
  {
    id: id(),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    pathName: text("path_name").notNull(),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    closedAt: ts("closed_at"),
  },
  (t) => [uniqueIndex("playback_sessions_path_idx").on(t.pathName), index("playback_sessions_camera_idx").on(t.cameraId)],
);

export const auditLogs = vms.table(
  "audit_logs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    actorId: uuid("actor_id"),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    entityLabel: text("entity_label"),
    /** JSON string with extra context. Never contains secrets. */
    details: text("details"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_time_idx").on(t.createdAt),
    index("audit_logs_actor_idx").on(t.actorId),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_action_idx").on(t.action),
  ],
);

export const settings = vms.table("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------
export const usersRelations = relations(users, ({ many }) => ({
  stores: many(userStores),
}));

export const storesRelations = relations(stores, ({ many }) => ({
  cameras: many(cameras),
  devices: many(devices),
  users: many(userStores),
}));

export const userStoresRelations = relations(userStores, ({ one }) => ({
  user: one(users, { fields: [userStores.userId], references: [users.id] }),
  store: one(stores, { fields: [userStores.storeId], references: [stores.id] }),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  store: one(stores, { fields: [devices.storeId], references: [stores.id] }),
  cameras: many(cameras),
  statusEvents: many(deviceStatusEvents),
}));

export const deviceStatusEventsRelations = relations(deviceStatusEvents, ({ one }) => ({
  device: one(devices, { fields: [deviceStatusEvents.deviceId], references: [devices.id] }),
}));

export const camerasRelations = relations(cameras, ({ one, many }) => ({
  store: one(stores, { fields: [cameras.storeId], references: [stores.id] }),
  device: one(devices, { fields: [cameras.deviceId], references: [devices.id] }),
  statusEvents: many(cameraStatusEvents),
}));

export const cameraStatusEventsRelations = relations(cameraStatusEvents, ({ one }) => ({
  camera: one(cameras, { fields: [cameraStatusEvents.cameraId], references: [cameras.id] }),
}));

export const playbackSessionsRelations = relations(playbackSessions, ({ one }) => ({
  camera: one(cameras, { fields: [playbackSessions.cameraId], references: [cameras.id] }),
}));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DeviceStatusEvent = typeof deviceStatusEvents.$inferSelect;
export type Camera = typeof cameras.$inferSelect;
export type NewCamera = typeof cameras.$inferInsert;
export type CameraStatusEvent = typeof cameraStatusEvents.$inferSelect;
export type PlaybackSession = typeof playbackSessions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
