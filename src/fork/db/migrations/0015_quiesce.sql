ALTER TABLE "fork_recovery_point" DROP CONSTRAINT "fork_recovery_point_reason_ck";--> statement-breakpoint
ALTER TABLE "fork_recovery_point" DROP CONSTRAINT "fork_recovery_point_consistency_ck";--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "quiesce_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "quiesce_services" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "quiesce_max_stop_seconds" integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "quiesce_enabled_by" text;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "quiesce_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD COLUMN "quiesce_state" text;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD COLUMN "quiesce_reason" text;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD COLUMN "quiesce_task_id" uuid;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD COLUMN "quiesce_start_task_id" uuid;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD COLUMN "quiesce_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD COLUMN "quiesce_release_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD COLUMN "quiesce_release_reason" text;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD COLUMN "quiesce_result" jsonb;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD CONSTRAINT "fork_stack_run_quiesce_task_id_fork_agent_task_id_fk" FOREIGN KEY ("quiesce_task_id") REFERENCES "public"."fork_agent_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD CONSTRAINT "fork_stack_run_quiesce_start_task_id_fork_agent_task_id_fk" FOREIGN KEY ("quiesce_start_task_id") REFERENCES "public"."fork_agent_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_stack_run_quiesce_idx" ON "fork_stack_run" USING btree ("stack_id","started_at") WHERE quiesce_task_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD CONSTRAINT "fork_stack_policy_quiesce_stop_ck" CHECK ("fork_stack_policy"."quiesce_max_stop_seconds" BETWEEN 60 AND 3600);--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD CONSTRAINT "fork_stack_policy_quiesce_ck" CHECK ("fork_stack_policy"."quiesce_enabled" = false OR ("fork_stack_policy"."quiesce_enabled_by" IS NOT NULL AND "fork_stack_policy"."quiesce_enabled_at" IS NOT NULL AND jsonb_array_length("fork_stack_policy"."quiesce_services") BETWEEN 1 AND 32));--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD CONSTRAINT "fork_stack_run_quiesce_state_ck" CHECK ("quiesce_state" IS NULL OR "quiesce_state" IN ('skipped', 'requested', 'stopped', 'not_started', 'refused', 'stop_failed', 'restarted', 'restart_failed', 'unconfirmed'));--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD CONSTRAINT "fork_stack_run_quiesce_reason_ck" CHECK ("quiesce_reason" IS NULL OR "quiesce_reason" IN ('flag_off', 'locked', 'capability_missing', 'agent_unenrolled', 'plan_blocked', 'enabler_lost', 'restore_busy', 'not_in_project', 'protected_in_project', 'container_changed', 'replica_not_listed', 'container_unstable', 'restore_owned', 'quiesce_pending', 'journal_unavailable', 'stop_failed', 'restart_unverified', 'quiesce_interrupted', 'protected_container', 'docker_unavailable', 'deadline_exceeded', 'payload_invalid', 'capability_missing_at_lease', 'execution_error', 'lease_lost', 'expired', 'agent_did_not_start'));--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD CONSTRAINT "fork_stack_run_quiesce_release_ck" CHECK ("quiesce_release_reason" IS NULL OR "quiesce_release_reason" IN ('capture_done', 'start_now', 'cancelled'));--> statement-breakpoint
ALTER TABLE "fork_stack_run" ADD CONSTRAINT "fork_stack_run_quiesce_result_ck" CHECK ("fork_stack_run"."quiesce_result" IS NULL OR octet_length("fork_stack_run"."quiesce_result"::text) <= 16384);--> statement-breakpoint
ALTER TABLE "fork_recovery_point" ADD CONSTRAINT "fork_recovery_point_reason_ck" CHECK ("downgrade_reason" IS NULL OR "downgrade_reason" IN ('fk_null', 'artifact_missing', 'count_mismatch', 'retention_partial', 'stack_removed', 'verify_failed', 'plaintext_hash_mismatch', 'validator_blocked', 'member_failed', 'member_timeout', 'unencrypted', 'checksum_unavailable', 'run_cancelled', 'run_not_started', 'run_error', 'quiesce_unconfirmed'));--> statement-breakpoint
ALTER TABLE "fork_recovery_point" ADD CONSTRAINT "fork_recovery_point_consistency_ck" CHECK ("consistency_level" IN ('crash_consistent_files', 'engine_dump', 'mixed', 'unknown', 'stopped'));