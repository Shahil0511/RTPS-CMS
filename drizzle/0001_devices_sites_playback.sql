CREATE TYPE "vms"."device_kind" AS ENUM('NVR', 'DVR', 'CAMERA');--> statement-breakpoint
CREATE TYPE "vms"."playback_mode" AS ENUM('NVR', 'LOCAL', 'NONE');--> statement-breakpoint
CREATE TYPE "vms"."site_kind" AS ENUM('STORE', 'CORPORATE', 'WAREHOUSE');--> statement-breakpoint
CREATE TABLE "vms"."device_status_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vms"."device_status_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"device_id" uuid NOT NULL,
	"status" "vms"."camera_status" NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "vms"."device_kind" DEFAULT 'NVR' NOT NULL,
	"vendor" text DEFAULT 'hikvision' NOT NULL,
	"host" text NOT NULL,
	"http_port" integer DEFAULT 80 NOT NULL,
	"https_enabled" boolean DEFAULT false NOT NULL,
	"rtsp_port" integer DEFAULT 554 NOT NULL,
	"username" text,
	"password_enc" text,
	"channel_count" integer,
	"model" text,
	"serial_number" text,
	"firmware" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"status" "vms"."camera_status" DEFAULT 'UNKNOWN' NOT NULL,
	"last_online_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"last_latency_ms" integer,
	"storage_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."playback_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camera_id" uuid NOT NULL,
	"user_id" uuid,
	"path_name" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "vms"."cameras" ALTER COLUMN "host" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vms"."cameras" ALTER COLUMN "record_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "vms"."cameras" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "vms"."cameras" ADD COLUMN "channel" integer;--> statement-breakpoint
ALTER TABLE "vms"."cameras" ADD COLUMN "playback_mode" "vms"."playback_mode" DEFAULT 'NVR' NOT NULL;--> statement-breakpoint
ALTER TABLE "vms"."stores" ADD COLUMN "kind" "vms"."site_kind" DEFAULT 'STORE' NOT NULL;--> statement-breakpoint
ALTER TABLE "vms"."device_status_events" ADD CONSTRAINT "device_status_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "vms"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD CONSTRAINT "devices_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "vms"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."playback_sessions" ADD CONSTRAINT "playback_sessions_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "vms"."cameras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."playback_sessions" ADD CONSTRAINT "playback_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "vms"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_status_events_device_time_idx" ON "vms"."device_status_events" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE INDEX "devices_store_idx" ON "vms"."devices" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_host_port_idx" ON "vms"."devices" USING btree ("host","rtsp_port");--> statement-breakpoint
CREATE UNIQUE INDEX "playback_sessions_path_idx" ON "vms"."playback_sessions" USING btree ("path_name");--> statement-breakpoint
CREATE INDEX "playback_sessions_camera_idx" ON "vms"."playback_sessions" USING btree ("camera_id");--> statement-breakpoint
ALTER TABLE "vms"."cameras" ADD CONSTRAINT "cameras_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "vms"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cameras_device_idx" ON "vms"."cameras" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "stores_kind_idx" ON "vms"."stores" USING btree ("kind");