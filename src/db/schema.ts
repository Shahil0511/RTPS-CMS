import { relations, sql } from "drizzle-orm";
import { boolean, index, integer, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

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

/**
 * How the server reaches a recorder.
 *  DIRECT          - reachable on its own address (LAN, public IP or port-forward).
 *  RELAY           - reachable through a relay/tunnel the server can address.
 *  PENDING_NETWORK - known recorder whose address is not reachable from the server yet.
 *  CLOUD_ONLY      - only reachable through a vendor cloud app (no API the server can use).
 * Only DIRECT and RELAY recorders are probed, streamed and alerted on.
 */
export const CONNECTION_MODES = ["DIRECT", "RELAY", "PENDING_NETWORK", "CLOUD_ONLY"] as const;
export type ConnectionMode = (typeof CONNECTION_MODES)[number];

export const DOWNTIME_ENTITY_TYPES = ["CAMERA", "DEVICE"] as const;
export type DowntimeEntityType = (typeof DOWNTIME_ENTITY_TYPES)[number];

export const EMAIL_KINDS = ["OFFLINE", "ONLINE", "DAILY_REPORT", "TEST"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** SENDING = claimed by one outbox flusher (so two processes never send the same row). */
export const EMAIL_STATUSES = ["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED_NO_SMTP"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

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
    /** Footage download override. Null = role default ("playback.export"). */
    allowDownload: boolean("allow_download"),
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
    /** Store mailbox, suggested as an alert recipient for this location. */
    email: text("email"),
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
    /**
     * When true the user sees only the cameras granted in vms.user_cameras for
     * this store (possibly none). Explicit so that deleting or moving the last
     * granted camera never silently widens access to the whole store.
     */
    cameraLimited: boolean("camera_limited").notNull().default(false),
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
    /** How the server reaches the recorder; only DIRECT/RELAY are probed and alerted on. host is "" when unknown. */
    connectionMode: text("connection_mode").$type<ConnectionMode>().notNull().default("DIRECT"),
    /** Vendor cloud the recorder is registered with (e.g. "InstaOnCloud", "Hik-Connect", "IH View"). */
    cloudPlatform: text("cloud_platform"),
    /** Cloud login identifier / device serial only. Never a password. */
    cloudAccount: text("cloud_account"),

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
  // Store LANs reuse 192.168.1.x, so an address is only unique within its store.
  (t) => [index("devices_store_idx").on(t.storeId), uniqueIndex("devices_store_host_port_idx").on(t.storeId, t.host, t.rtspPort)],
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

/**
 * Per-camera grants. A user sees the cameras of their assigned stores; when a user has any
 * rows here for a store, they see ONLY those cameras within that store. Admins see everything.
 */
export const userCameras = vms.table(
  "user_cameras",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    cameraId: uuid("camera_id")
      .notNull()
      .references(() => cameras.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.cameraId] }), index("user_cameras_camera_idx").on(t.cameraId)],
);

/**
 * One row per offline period of a camera or recorder. Names are snapshots so history survives
 * renames/deletes: deleting a camera/recorder only clears the link (SET NULL), never the row.
 * At most one open incident (ended_at null) per camera and per recorder (partial unique indexes).
 */
export const downtimeIncidents = vms.table(
  "downtime_incidents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    entityType: text("entity_type").$type<DowntimeEntityType>().notNull(),
    cameraId: uuid("camera_id").references(() => cameras.id, { onDelete: "set null" }),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "set null" }),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "set null" }),
    entityName: text("entity_name").notNull(),
    storeName: text("store_name"),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    durationSeconds: integer("duration_seconds"),
    startDetail: text("start_detail"),
    endDetail: text("end_detail"),
    /** Camera incident caused by its recorder being down. */
    parentIncidentId: integer("parent_incident_id").references((): AnyPgColumn => downtimeIncidents.id, { onDelete: "set null" }),
    /**
     * Offline-alert grace counts from here instead of startedAt. Set on a camera that is still
     * down when its recorder comes back: it was covered by the recorder's alert until then.
     */
    graceFrom: ts("grace_from"),
    /**
     * Opened by reconciliation for an entity that was already offline before alerting could see it
     * (e.g. first run). Never emailed: downAlertedAt is set at creation and upAlertedAt on close.
     */
    backfilled: boolean("backfilled").notNull().default(false),
    downAlertedAt: ts("down_alerted_at"),
    /** Restore handled: notice sent, or deliberately not sent (silent close, backfill, stale, short flap). */
    upAlertedAt: ts("up_alerted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("downtime_incidents_started_idx").on(t.startedAt),
    index("downtime_incidents_camera_idx").on(t.entityType, t.cameraId),
    index("downtime_incidents_device_idx").on(t.entityType, t.deviceId),
    index("downtime_incidents_store_idx").on(t.storeId),
    index("downtime_incidents_open_idx").on(t.entityType).where(sql`"ended_at" is null`),
    index("downtime_incidents_parent_idx").on(t.parentIncidentId),
    /** Alert dispatch candidates: everything whose restore is not handled yet (stays small). */
    index("downtime_incidents_pending_alert_idx").on(t.endedAt).where(sql`"up_alerted_at" is null`),
    uniqueIndex("downtime_incidents_one_open_camera_idx").on(t.cameraId).where(sql`"ended_at" is null and "entity_type" = 'CAMERA'`),
    uniqueIndex("downtime_incidents_one_open_device_idx").on(t.deviceId).where(sql`"ended_at" is null and "entity_type" = 'DEVICE'`),
  ],
);

/** Who gets offline/online alerts and the daily report. storeId null = all locations. */
export const alertRecipients = vms.table(
  "alert_recipients",
  {
    id: id(),
    name: text("name"),
    email: text("email").notNull(),
    storeId: uuid("store_id").references(() => stores.id, { onDelete: "cascade" }),
    onOffline: boolean("on_offline").notNull().default(true),
    onOnline: boolean("on_online").notNull().default(true),
    dailyReport: boolean("daily_report").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("alert_recipients_store_idx").on(t.storeId)],
);

/** Every email the system produces, sent or not, so delivery is visible in the UI. */
export const emailOutbox = vms.table(
  "email_outbox",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").$type<EmailKind>().notNull(),
    toAddress: text("to_address").notNull(),
    subject: text("subject").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html").notNull(),
    status: text("status").$type<EmailStatus>().notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    /** When a flusher claimed the row (status SENDING). */
    claimedAt: ts("claimed_at"),
    sentAt: ts("sent_at"),
  },
  (t) => [index("email_outbox_status_time_idx").on(t.status, t.createdAt)],
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
  cameras: many(userCameras),
}));

export const storesRelations = relations(stores, ({ many }) => ({
  cameras: many(cameras),
  devices: many(devices),
  users: many(userStores),
  alertRecipients: many(alertRecipients),
  downtimeIncidents: many(downtimeIncidents),
}));

export const userStoresRelations = relations(userStores, ({ one }) => ({
  user: one(users, { fields: [userStores.userId], references: [users.id] }),
  store: one(stores, { fields: [userStores.storeId], references: [stores.id] }),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  store: one(stores, { fields: [devices.storeId], references: [stores.id] }),
  cameras: many(cameras),
  statusEvents: many(deviceStatusEvents),
  downtimeIncidents: many(downtimeIncidents),
}));

export const deviceStatusEventsRelations = relations(deviceStatusEvents, ({ one }) => ({
  device: one(devices, { fields: [deviceStatusEvents.deviceId], references: [devices.id] }),
}));

export const camerasRelations = relations(cameras, ({ one, many }) => ({
  store: one(stores, { fields: [cameras.storeId], references: [stores.id] }),
  device: one(devices, { fields: [cameras.deviceId], references: [devices.id] }),
  statusEvents: many(cameraStatusEvents),
  userGrants: many(userCameras),
  downtimeIncidents: many(downtimeIncidents),
}));

export const userCamerasRelations = relations(userCameras, ({ one }) => ({
  user: one(users, { fields: [userCameras.userId], references: [users.id] }),
  camera: one(cameras, { fields: [userCameras.cameraId], references: [cameras.id] }),
}));

export const downtimeIncidentsRelations = relations(downtimeIncidents, ({ one }) => ({
  camera: one(cameras, { fields: [downtimeIncidents.cameraId], references: [cameras.id] }),
  device: one(devices, { fields: [downtimeIncidents.deviceId], references: [devices.id] }),
  store: one(stores, { fields: [downtimeIncidents.storeId], references: [stores.id] }),
}));

export const alertRecipientsRelations = relations(alertRecipients, ({ one }) => ({
  store: one(stores, { fields: [alertRecipients.storeId], references: [stores.id] }),
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
export type UserCamera = typeof userCameras.$inferSelect;
export type NewUserCamera = typeof userCameras.$inferInsert;
export type DowntimeIncident = typeof downtimeIncidents.$inferSelect;
export type NewDowntimeIncident = typeof downtimeIncidents.$inferInsert;
export type AlertRecipient = typeof alertRecipients.$inferSelect;
export type NewAlertRecipient = typeof alertRecipients.$inferInsert;
export type EmailOutbox = typeof emailOutbox.$inferSelect;
export type NewEmailOutbox = typeof emailOutbox.$inferInsert;
