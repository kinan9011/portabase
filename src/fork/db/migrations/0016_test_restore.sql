CREATE TABLE "fork_test_restore_schedule" (
	"stack_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"schedule" jsonb NOT NULL,
	"target_agent_id" uuid,
	"restore_root" text,
	"stale_after_days" integer DEFAULT 14 NOT NULL,
	"enabled_by" text,
	"enabled_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"last_scheduled_at" timestamp with time zone,
	"last_outcome" text,
	"last_reason" text,
	"last_outcome_at" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fork_tr_schedule_stale_ck" CHECK ("fork_test_restore_schedule"."stale_after_days" BETWEEN 1 AND 90),
	CONSTRAINT "fork_tr_schedule_enabled_ck" CHECK (NOT "fork_test_restore_schedule"."enabled" OR ("fork_test_restore_schedule"."enabled_by" IS NOT NULL AND "fork_test_restore_schedule"."enabled_at" IS NOT NULL AND "fork_test_restore_schedule"."target_agent_id" IS NOT NULL AND "fork_test_restore_schedule"."restore_root" IS NOT NULL)),
	CONSTRAINT "fork_tr_schedule_outcome_ck" CHECK ("fork_test_restore_schedule"."last_outcome" IS NULL OR "fork_test_restore_schedule"."last_outcome" IN ('started','skipped','waiting')),
	CONSTRAINT "fork_tr_schedule_reason_ck" CHECK (("fork_test_restore_schedule"."last_reason" IS NULL OR "fork_test_restore_schedule"."last_reason" ~ '^[a-z_]{1,64}$') AND ("fork_test_restore_schedule"."pause_reason" IS NULL OR "fork_test_restore_schedule"."pause_reason" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "fork_tr_schedule_root_ck" CHECK ("fork_test_restore_schedule"."restore_root" IS NULL OR octet_length("fork_test_restore_schedule"."restore_root") <= 1024),
	CONSTRAINT "fork_tr_schedule_size_ck" CHECK (octet_length("fork_test_restore_schedule"."schedule"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "fork_restore_run" DROP CONSTRAINT "fork_restore_run_verification_ck";--> statement-breakpoint
ALTER TABLE "fork_restore_run_task" DROP CONSTRAINT "fork_restore_run_task_step_ck";--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD COLUMN "integrity" jsonb;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD COLUMN "wipe_state" text;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD COLUMN "wipe_reason" text;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD COLUMN "wipe_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD COLUMN "wipe_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD COLUMN "wipe_by" text;--> statement-breakpoint
ALTER TABLE "fork_test_restore_schedule" ADD CONSTRAINT "fork_test_restore_schedule_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_test_restore_schedule" ADD CONSTRAINT "fork_test_restore_schedule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_test_restore_schedule" ADD CONSTRAINT "fork_test_restore_schedule_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_restore_run_test_facet_idx" ON "fork_restore_run" USING btree ("stack_id","finished_at") WHERE purpose = 'test_restore' AND state = 'succeeded' AND verification = 'data_verified' AND wipe_state = 'verified';--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_trigger_ck" CHECK ("fork_restore_run"."trigger" IN ('manual','schedule'));--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_wipe_ck" CHECK (("fork_restore_run"."wipe_state" IS NULL OR "fork_restore_run"."wipe_state" IN ('running','verified','not_needed','failed')) AND ("fork_restore_run"."wipe_reason" IS NULL OR "fork_restore_run"."wipe_reason" ~ '^[a-z_]{1,64}$'));--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_integrity_ck" CHECK ("fork_restore_run"."integrity" IS NULL OR octet_length("fork_restore_run"."integrity"::text) <= 1024);--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_verification_ck" CHECK ("verification" IS NULL OR "verification" IN ('started', 'data_only', 'data_verified'));--> statement-breakpoint
ALTER TABLE "fork_restore_run_task" ADD CONSTRAINT "fork_restore_run_task_step_ck" CHECK ("step" IN ('probe', 'stage', 'apply', 'render', 'restore_db', 'compose_up', 'cleanup', 'integrity', 'wipe', 'wipe_check'));