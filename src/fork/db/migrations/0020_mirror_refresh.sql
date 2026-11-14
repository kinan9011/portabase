ALTER TABLE "fork_mirror" DROP CONSTRAINT "fork_mirror_status_ck";--> statement-breakpoint
ALTER TABLE "fork_mirror_event" DROP CONSTRAINT "fork_mirror_event_kind_ck";--> statement-breakpoint
ALTER TABLE "fork_mirror_task" DROP CONSTRAINT "fork_mirror_task_step_ck";--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD COLUMN "route_port" integer;--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD COLUMN "route_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD COLUMN "op_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "fork_mirror_revision" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD CONSTRAINT "fork_mirror_route_revision_id_fork_mirror_revision_id_fk" FOREIGN KEY ("route_revision_id") REFERENCES "public"."fork_mirror_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD CONSTRAINT "fork_mirror_op_revision_id_fork_mirror_revision_id_fk" FOREIGN KEY ("op_revision_id") REFERENCES "public"."fork_mirror_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fork_mirror_route_port_runner_uq" ON "fork_mirror" USING btree ("runner_agent_id","route_port") WHERE route_port IS NOT NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fork_mirror_revision_one_active_mirror_uq" ON "fork_mirror_revision" USING btree ("mirror_id") WHERE state IN ('requested','planning','validating','staging','restoring_files','transforming','restoring_db','starting','healthchecking');--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD CONSTRAINT "fork_mirror_route_port_ck" CHECK ("fork_mirror"."route_port" IS NULL OR "fork_mirror"."route_port" BETWEEN 41000 AND 41999);--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD CONSTRAINT "fork_mirror_status_ck" CHECK ("status" IN ('creating', 'ready', 'failed', 'cancelled', 'refreshing', 'deleting', 'deleted', 'stopping', 'stopped', 'starting', 'rolling_back'));--> statement-breakpoint
ALTER TABLE "fork_mirror_event" ADD CONSTRAINT "fork_mirror_event_kind_ck" CHECK ("kind" IN ('requested', 'state_changed', 'gate_passed', 'gate_failed', 'blocked', 'failed', 'cancel_requested', 'cancelled', 'ready', 'wipe_started', 'wipe_verified', 'wipe_failed', 'activated', 'retired', 'rolled_back'));--> statement-breakpoint
ALTER TABLE "fork_mirror_task" ADD CONSTRAINT "fork_mirror_task_step_ck" CHECK ("step" IN ('probe', 'stage', 'apply', 'render', 'finalize', 'restore_db', 'up', 'check', 'isolation', 'wipe', 'wipe_check', 'stop', 'route'));