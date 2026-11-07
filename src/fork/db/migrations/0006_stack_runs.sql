CREATE TABLE "fork_stack_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"state" text DEFAULT 'starting' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"skip_reason" text,
	"triggered_by" text,
	"inventory_version" integer,
	"inventory_refresh" text,
	"validator_blocked" boolean DEFAULT false NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_stack_run_slot_uq" UNIQUE("stack_id","scheduled_for"),
	CONSTRAINT "fork_stack_run_trigger_ck" CHECK ("trigger" IN ('schedule', 'manual')),
	CONSTRAINT "fork_stack_run_state_ck" CHECK ("state" IN ('starting', 'running', 'finalizing', 'succeeded', 'incomplete', 'failed', 'cancelled', 'skipped')),
	CONSTRAINT "fork_stack_run_skip_reason_ck" CHECK ("skip_reason" IS NULL OR "skip_reason" IN ('overlap', 'missed')),
	CONSTRAINT "fork_stack_run_reason_ck" CHECK ("reason" IS NULL OR "reason" IN ('agent_did_not_start', 'agent_made_no_progress', 'run_timeout', 'member_failed', 'member_busy', 'member_method_conflict', 'member_not_active', 'member_vanished', 'storage_failed', 'nothing_queued', 'cancelled', 'interrupted', 'capacity', 'internal_error')),
	CONSTRAINT "fork_stack_run_refresh_ck" CHECK ("inventory_refresh" IS NULL OR "inventory_refresh" IN ('ok', 'failed', 'skipped_locked', 'not_attempted')),
	CONSTRAINT "fork_stack_run_skipped_ck" CHECK ("fork_stack_run"."state" <> 'skipped' OR "fork_stack_run"."skip_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "fork_stack_run_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stack_source_id" uuid,
	"backup_id" uuid,
	"source_name" text NOT NULL,
	"dbms" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_progress_at" timestamp with time zone,
	"checksums" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "fork_stack_run_item_state_ck" CHECK ("state" IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "fork_stack_run_item_reason_ck" CHECK ("reason" IS NULL OR "reason" IN ('agent_did_not_start', 'agent_made_no_progress', 'run_timeout', 'member_failed', 'member_busy', 'member_method_conflict', 'member_not_active', 'member_vanished', 'storage_failed', 'nothing_queued', 'cancelled', 'interrupted', 'capacity', 'internal_error'))
);
--> statement-breakpoint
ALTER TABLE "fork_recovery_point" DROP CONSTRAINT "fork_recovery_point_reason_ck";--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD CONSTRAINT "fork_stack_run_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack_run_item" ADD CONSTRAINT "fork_stack_run_item_run_id_fork_stack_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fork_stack_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack_run_item" ADD CONSTRAINT "fork_stack_run_item_stack_source_id_fork_stack_source_id_fk" FOREIGN KEY ("stack_source_id") REFERENCES "public"."fork_stack_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack_run_item" ADD CONSTRAINT "fork_stack_run_item_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fork_stack_run_one_active_uq" ON "fork_stack_run" USING btree ("stack_id") WHERE state IN ('starting','running','finalizing');--> statement-breakpoint
CREATE INDEX "fork_stack_run_stack_started_idx" ON "fork_stack_run" USING btree ("stack_id","started_at");--> statement-breakpoint
CREATE INDEX "fork_stack_run_item_run_idx" ON "fork_stack_run_item" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "fork_stack_run_item_backup_idx" ON "fork_stack_run_item" USING btree ("backup_id");--> statement-breakpoint
ALTER TABLE "fork_recovery_point" ADD CONSTRAINT "fork_recovery_point_run_id_fork_stack_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fork_stack_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_recovery_point_artifact" ADD CONSTRAINT "fork_recovery_point_artifact_stack_source_id_fork_stack_source_id_fk" FOREIGN KEY ("stack_source_id") REFERENCES "public"."fork_stack_source"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_recovery_point" ADD CONSTRAINT "fork_recovery_point_run_uq" UNIQUE("run_id");--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD CONSTRAINT "fork_stack_policy_pause_reason_ck" CHECK ("pause_reason" IS NULL OR "pause_reason" IN ('user_missing', 'user_blocked', 'capability_lost', 'agent_acl_lost', 'encryption_off', 'channels_unavailable', 'agent_gone'));--> statement-breakpoint
ALTER TABLE "fork_recovery_point" ADD CONSTRAINT "fork_recovery_point_reason_ck" CHECK ("downgrade_reason" IS NULL OR "downgrade_reason" IN ('fk_null', 'artifact_missing', 'count_mismatch', 'retention_partial', 'stack_removed', 'verify_failed', 'plaintext_hash_mismatch', 'validator_blocked', 'member_failed', 'member_timeout', 'unencrypted', 'checksum_unavailable', 'run_cancelled', 'run_not_started', 'run_error'));