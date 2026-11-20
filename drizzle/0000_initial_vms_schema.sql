CREATE SCHEMA IF NOT EXISTS "vms";
--> statement-breakpoint
CREATE TYPE "vms"."camera_status" AS ENUM('ONLINE', 'OFFLINE', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "vms"."user_role" AS ENUM('ADMIN', 'MANAGER', 'VIEWER');--> statement-breakpoint
CREATE TYPE "vms"."rtsp_transport" AS ENUM('tcp', 'udp', 'automatic');--> statement-breakpoint
CREATE TABLE "vms"."audit_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vms"."audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"actor_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"entity_label" text,
	"details" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."camera_status_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vms"."camera_status_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"camera_id" uuid NOT NULL,
	"status" "vms"."camera_status" NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."cameras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"path_name" text NOT NULL,
	"description" text,
	"host" text NOT NULL,
	"port" integer DEFAULT 554 NOT NULL,
	"username" text,
	"password_enc" text,
	"rtsp_path" text DEFAULT '/' NOT NULL,
	"transport" "vms"."rtsp_transport" DEFAULT 'tcp' NOT NULL,
	"record_enabled" boolean DEFAULT true NOT NULL,
	"retention_days" integer DEFAULT 7 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" "vms"."camera_status" DEFAULT 'UNKNOWN' NOT NULL,
	"last_online_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"last_latency_ms" integer,
	"video_codec" text,
	"audio_codec" text,
	"resolution" text,
	"reader_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"region" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"phone" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms"."user_stores" (
	"user_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	CONSTRAINT "user_stores_user_id_store_id_pk" PRIMARY KEY("user_id","store_id")
);
--> statement-breakpoint
CREATE TABLE "vms"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "vms"."user_role" DEFAULT 'VIEWER' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vms"."camera_status_events" ADD CONSTRAINT "camera_status_events_camera_id_cameras_id_fk" FOREIGN KEY ("camera_id") REFERENCES "vms"."cameras"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."cameras" ADD CONSTRAINT "cameras_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "vms"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."user_stores" ADD CONSTRAINT "user_stores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "vms"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vms"."user_stores" ADD CONSTRAINT "user_stores_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "vms"."stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_time_idx" ON "vms"."audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "vms"."audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "vms"."audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "vms"."audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "camera_status_events_camera_time_idx" ON "vms"."camera_status_events" USING btree ("camera_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cameras_path_name_idx" ON "vms"."cameras" USING btree ("path_name");--> statement-breakpoint
CREATE INDEX "cameras_store_idx" ON "vms"."cameras" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "cameras_status_idx" ON "vms"."cameras" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "stores_code_idx" ON "vms"."stores" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "vms"."users" USING btree ("email");