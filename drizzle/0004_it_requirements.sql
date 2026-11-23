CREATE TABLE "vms"."alert_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"store_id" uuid,
	"on_offline" boolean DEFAULT true NOT NULL,
	"on_online" boolean DEFAULT true NOT NULL,
	"daily_report" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."downtime_incidents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vms"."downtime_incidents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entity_type" text NOT NULL,
	"camera_id" uuid,
	"device_id" uuid,
	"store_id" uuid,
	"entity_name" text NOT NULL,
	"store_name" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"start_detail" text,
	"end_detail" text,
	"parent_incident_id" integer,
	"grace_from" timestamp with time zone,
	"backfilled" boolean DEFAULT false NOT NULL,
	"down_alerted_at" timestamp with time zone,
	"up_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."email_outbox" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vms"."email_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vms"."user_cameras" (
	"user_id" uuid NOT NULL,
	"camera_id" uuid NOT NULL,
	CONSTRAINT "user_cameras_user_id_camera_id_pk" PRIMARY KEY("user_id","camera_id")
);
--> statement-breakpoint
DROP INDEX "vms"."devices_host_port_idx";--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "connection_mode" text DEFAULT 'DIRECT' NOT NULL;--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "cloud_platform" text;--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "cloud_account" text;--> statement-breakpoint
ALTER TABLE "vms"."stores" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "vms"."user_stores" ADD COLUMN "camera_limited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vms"."users" ADD COLUMN "allow_download" boolean;--> statement-breakpoint
ALTER TABLE "vms"."alert_recipients" ADD CONSTRAINT "alert_recipients_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "vms"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."downtime_incidents" ADD CONSTRAINT "downtime_incidents_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "vms"."cameras"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."downtime_incidents" ADD CONSTRAINT "downtime_incidents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "vms"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."downtime_incidents" ADD CONSTRAINT "downtime_incidents_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "vms"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."downtime_incidents" ADD CONSTRAINT "downtime_incidents_parent_incident_id_downtime_incidents_id_fk" FOREIGN KEY ("parent_incident_id") REFERENCES "vms"."downtime_incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."user_cameras" ADD CONSTRAINT "user_cameras_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "vms"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."user_cameras" ADD CONSTRAINT "user_cameras_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "vms"."cameras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_recipients_store_idx" ON "vms"."alert_recipients" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "downtime_incidents_started_idx" ON "vms"."downtime_incidents" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "downtime_incidents_camera_idx" ON "vms"."downtime_incidents" USING btree ("entity_type","camera_id");--> statement-breakpoint
CREATE INDEX "downtime_incidents_device_idx" ON "vms"."downtime_incidents" USING btree ("entity_type","device_id");--> statement-breakpoint
CREATE INDEX "downtime_incidents_store_idx" ON "vms"."downtime_incidents" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "downtime_incidents_open_idx" ON "vms"."downtime_incidents" USING btree ("entity_type") WHERE "ended_at" is null;--> statement-breakpoint
CREATE INDEX "downtime_incidents_parent_idx" ON "vms"."downtime_incidents" USING btree ("parent_incident_id");--> statement-breakpoint
CREATE INDEX "downtime_incidents_pending_alert_idx" ON "vms"."downtime_incidents" USING btree ("ended_at") WHERE "up_alerted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "downtime_incidents_one_open_camera_idx" ON "vms"."downtime_incidents" USING btree ("camera_id") WHERE "ended_at" is null and "entity_type" = 'CAMERA';--> statement-breakpoint
CREATE UNIQUE INDEX "downtime_incidents_one_open_device_idx" ON "vms"."downtime_incidents" USING btree ("device_id") WHERE "ended_at" is null and "entity_type" = 'DEVICE';--> statement-breakpoint
CREATE INDEX "email_outbox_status_time_idx" ON "vms"."email_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "user_cameras_camera_idx" ON "vms"."user_cameras" USING btree ("camera_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_store_host_port_idx" ON "vms"."devices" USING btree ("store_id","host","rtsp_port");