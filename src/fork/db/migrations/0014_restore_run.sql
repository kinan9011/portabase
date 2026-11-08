CREATE TABLE "fork_restore_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"stack_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_hash" text NOT NULL,
	"rp_id" uuid,
	"rp_sequence" bigint NOT NULL,
	"target_agent_id" uuid,
	"target_agent_name" text NOT NULL,
	"purpose" text NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"reason" text,
	"failed_step" text,
	"verification" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmation" text NOT NULL,
	"accept_missing_inputs" boolean DEFAULT false NOT NULL,
	"policy_approval" jsonb,
	"policy_approval_sha256" text,
	"policy_approved_by" text,
	"policy_approved_at" timestamp with time zone,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"cancel_requested_by" text,
	"started_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fork_restore_run_plan_id_unique" UNIQUE("plan_id"),
	CONSTRAINT "fork_restore_run_state_ck" CHECK ("state" IN ('running', 'awaiting_approval', 'succeeded', 'incomplete', 'failed', 'cancelled')),
	CONSTRAINT "fork_restore_run_purpose_ck" CHECK ("purpose" IN ('restore', 'test_restore')),
	CONSTRAINT "fork_restore_run_mode_ck" CHECK ("fork_restore_run"."mode" IN ('new_stack','selective')),
	CONSTRAINT "fork_restore_run_verification_ck" CHECK ("verification" IS NULL OR "verification" IN ('started', 'data_only')),
	CONSTRAINT "fork_restore_run_confirmation_ck" CHECK ("fork_restore_run"."confirmation" IN ('typed','not_required')),
	CONSTRAINT "fork_restore_run_reason_ck" CHECK ("fork_restore_run"."reason" IS NULL OR "fork_restore_run"."reason" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "fork_restore_run_hash_ck" CHECK ("fork_restore_run"."plan_hash" ~ '^[0-9a-f]{64}$' AND ("fork_restore_run"."policy_approval_sha256" IS NULL OR "fork_restore_run"."policy_approval_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "fork_restore_run_final_ck" CHECK ("fork_restore_run"."state" IN ('running','awaiting_approval') OR "fork_restore_run"."finished_at" IS NOT NULL),
	CONSTRAINT "fork_restore_run_failed_ck" CHECK ("fork_restore_run"."state" NOT IN ('failed','incomplete') OR "fork_restore_run"."reason" IS NOT NULL),
	CONSTRAINT "fork_restore_run_size_ck" CHECK (octet_length("fork_restore_run"."steps"::text) <= 65536 AND octet_length("fork_restore_run"."services"::text) <= 65536 AND ("fork_restore_run"."policy_approval" IS NULL OR octet_length("fork_restore_run"."policy_approval"::text) <= 262144))
);
--> statement-breakpoint
CREATE TABLE "fork_restore_run_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"step" text NOT NULL,
	"attempt" integer NOT NULL,
	"task_type" text NOT NULL,
	"task_id" uuid,
	"override_revision" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fork_restore_run_task_task_id_unique" UNIQUE("task_id"),
	CONSTRAINT "fork_restore_run_task_step_attempt_uq" UNIQUE("run_id","step","attempt"),
	CONSTRAINT "fork_restore_run_task_step_ck" CHECK ("step" IN ('probe', 'stage', 'apply', 'render', 'restore_db', 'compose_up', 'cleanup')),
	CONSTRAINT "fork_restore_run_task_attempt_ck" CHECK ("fork_restore_run_task"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_plan_id_fork_restore_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."fork_restore_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_rp_id_fork_recovery_point_id_fk" FOREIGN KEY ("rp_id") REFERENCES "public"."fork_recovery_point"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_run" ADD CONSTRAINT "fork_restore_run_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_run_task" ADD CONSTRAINT "fork_restore_run_task_run_id_fork_restore_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fork_restore_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_run_task" ADD CONSTRAINT "fork_restore_run_task_task_id_fork_agent_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."fork_agent_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fork_restore_run_one_active_target_uq" ON "fork_restore_run" USING btree ("target_agent_id") WHERE state IN ('running','awaiting_approval') AND target_agent_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "fork_restore_run_stack_created_idx" ON "fork_restore_run" USING btree ("stack_id","created_at");