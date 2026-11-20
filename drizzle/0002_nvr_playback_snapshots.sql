CREATE TABLE "vms"."health_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vms"."health_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"cameras_total" integer NOT NULL,
	"cameras_online" integer NOT NULL,
	"devices_total" integer NOT NULL,
	"devices_online" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "storage_total_mb" integer;--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "storage_free_mb" integer;--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "time_mode" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "utc_offset_minutes" integer;--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "info_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "health_snapshots_time_idx" ON "vms"."health_snapshots" USING btree ("created_at");--> statement-breakpoint
UPDATE "vms"."cameras" SET "record_enabled" = false WHERE "playback_mode" = 'NVR';
