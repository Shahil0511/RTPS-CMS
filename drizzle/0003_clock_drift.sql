DROP TABLE "vms"."health_snapshots" CASCADE;--> statement-breakpoint
ALTER TABLE "vms"."devices" ADD COLUMN "clock_drift_seconds" integer;