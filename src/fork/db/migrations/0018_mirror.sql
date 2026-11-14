CREATE TABLE "fork_mirror" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stack_id" uuid NOT NULL,
	"runner_agent_id" uuid,
	"runner_agent_name" text NOT NULL,
	"name" text NOT NULL,
	"policy" jsonb NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"active_revision_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "fork_mirror_name_ck" CHECK ("fork_mirror"."name" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
	CONSTRAINT "fork_mirror_status_ck" CHECK ("status" IN ('creating', 'ready', 'failed', 'cancelled', 'refreshing', 'deleting', 'deleted')),
	CONSTRAINT "fork_mirror_policy_size_ck" CHECK (octet_length("fork_mirror"."policy"::text) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "fork_mirror_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mirror_id" uuid NOT NULL,
	"revision_id" uuid,
	"kind" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"code" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"at" timestamp with time zone NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "fork_mirror_event_kind_ck" CHECK ("kind" IN ('requested', 'state_changed', 'gate_passed', 'gate_failed', 'blocked', 'failed', 'cancel_requested', 'cancelled', 'ready', 'wipe_started', 'wipe_verified', 'wipe_failed')),
	CONSTRAINT "fork_mirror_event_actor_ck" CHECK ("fork_mirror_event"."actor_kind" IN ('user','system')),
	CONSTRAINT "fork_mirror_event_code_ck" CHECK ("fork_mirror_event"."code" IS NULL OR "fork_mirror_event"."code" ~ '^[a-z_]{1,64}$'),
	CONSTRAINT "fork_mirror_event_details_ck" CHECK (octet_length("fork_mirror_event"."details"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "fork_mirror_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mirror_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"stack_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"rp_id" uuid,
	"rp_sequence" bigint NOT NULL,
	"plan_id" uuid,
	"plan_hash" text NOT NULL,
	"runner_agent_id" uuid,
	"project" text NOT NULL,
	"workspace" text NOT NULL,
	"host_port" integer NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"reason" text,
	"failed_step" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refusals" jsonb,
	"spec" jsonb,
	"spec_sha256" text,
	"source_view_sha256" text,
	"final_view_sha256" text,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"probe_task_id" uuid,
	"started_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"readied_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_seconds" integer,
	"cancel_requested_at" timestamp with time zone,
	"cancel_requested_by" text,
	"wipe_state" text,
	"wipe_reason" text,
	"wipe_started_at" timestamp with time zone,
	"wipe_finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fork_mirror_revision_seq_uq" UNIQUE("mirror_id","seq"),
	CONSTRAINT "fork_mirror_revision_seq_ck" CHECK ("fork_mirror_revision"."seq" >= 1),
	CONSTRAINT "fork_mirror_revision_state_ck" CHECK ("state" IN ('requested', 'planning', 'validating', 'staging', 'restoring_files', 'transforming', 'restoring_db', 'starting', 'healthchecking', 'ready', 'blocked', 'failed', 'cancelled', 'rolled_back')),
	CONSTRAINT "fork_mirror_revision_project_ck" CHECK ("fork_mirror_revision"."project" ~ '^pbm-[a-z0-9][a-z0-9-]{0,58}$'),
	CONSTRAINT "fork_mirror_revision_workspace_ck" CHECK (octet_length("fork_mirror_revision"."workspace") <= 1024),
	CONSTRAINT "fork_mirror_revision_port_ck" CHECK ("fork_mirror_revision"."host_port" BETWEEN 41000 AND 41999),
	CONSTRAINT "fork_mirror_revision_reason_ck" CHECK (("fork_mirror_revision"."reason" IS NULL OR "fork_mirror_revision"."reason" ~ '^[a-z_]{1,64}$') AND ("fork_mirror_revision"."wipe_reason" IS NULL OR "fork_mirror_revision"."wipe_reason" ~ '^[a-z_]{1,64}$')),
	CONSTRAINT "fork_mirror_revision_hash_ck" CHECK ("fork_mirror_revision"."plan_hash" ~ '^[0-9a-f]{64}$' AND ("fork_mirror_revision"."spec_sha256" IS NULL OR "fork_mirror_revision"."spec_sha256" ~ '^[0-9a-f]{64}$') AND ("fork_mirror_revision"."source_view_sha256" IS NULL OR "fork_mirror_revision"."source_view_sha256" ~ '^[0-9a-f]{64}$') AND ("fork_mirror_revision"."final_view_sha256" IS NULL OR "fork_mirror_revision"."final_view_sha256" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "fork_mirror_revision_wipe_ck" CHECK ("wipe_state" IS NULL OR "wipe_state" IN ('running', 'verified', 'not_needed', 'failed')),
	CONSTRAINT "fork_mirror_revision_final_ck" CHECK (state IN ('requested','planning','validating','staging','restoring_files','transforming','restoring_db','starting','healthchecking') OR "fork_mirror_revision"."finished_at" IS NOT NULL),
	CONSTRAINT "fork_mirror_revision_failed_ck" CHECK ("fork_mirror_revision"."state" NOT IN ('failed','blocked') OR "fork_mirror_revision"."reason" IS NOT NULL),
	CONSTRAINT "fork_mirror_revision_ready_ck" CHECK ("fork_mirror_revision"."state" <> 'ready' OR ("fork_mirror_revision"."readied_at" IS NOT NULL AND "fork_mirror_revision"."final_view_sha256" IS NOT NULL AND "fork_mirror_revision"."spec_sha256" IS NOT NULL AND "fork_mirror_revision"."probe_task_id" IS NOT NULL)),
	CONSTRAINT "fork_mirror_revision_size_ck" CHECK (octet_length("fork_mirror_revision"."steps"::text) <= 65536 AND octet_length("fork_mirror_revision"."services"::text) <= 65536 AND octet_length("fork_mirror_revision"."gates"::text) <= 4096 AND ("fork_mirror_revision"."refusals" IS NULL OR octet_length("fork_mirror_revision"."refusals"::text) <= 8192) AND ("fork_mirror_revision"."spec" IS NULL OR octet_length("fork_mirror_revision"."spec"::text) <= 524288))
);
--> statement-breakpoint
CREATE TABLE "fork_mirror_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"step" text NOT NULL,
	"attempt" integer NOT NULL,
	"task_type" text NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fork_mirror_task_task_id_unique" UNIQUE("task_id"),
	CONSTRAINT "fork_mirror_task_step_attempt_uq" UNIQUE("revision_id","step","attempt"),
	CONSTRAINT "fork_mirror_task_step_ck" CHECK ("step" IN ('probe', 'stage', 'apply', 'render', 'finalize', 'restore_db', 'up', 'check', 'isolation', 'wipe', 'wipe_check')),
	CONSTRAINT "fork_mirror_task_attempt_ck" CHECK ("fork_mirror_task"."attempt" >= 1)
);
--> statement-breakpoint
ALTER TABLE "fork_restore_plan" DROP CONSTRAINT "fork_restore_plan_purpose_ck";--> statement-breakpoint
ALTER TABLE "fork_stack" ADD COLUMN "mirror_opt_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_stack" ADD COLUMN "mirror_opt_in_by" text;--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD CONSTRAINT "fork_mirror_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD CONSTRAINT "fork_mirror_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD CONSTRAINT "fork_mirror_runner_agent_id_agents_id_fk" FOREIGN KEY ("runner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror" ADD CONSTRAINT "fork_mirror_active_revision_id_fork_mirror_revision_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."fork_mirror_revision"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_event" ADD CONSTRAINT "fork_mirror_event_mirror_id_fork_mirror_id_fk" FOREIGN KEY ("mirror_id") REFERENCES "public"."fork_mirror"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_event" ADD CONSTRAINT "fork_mirror_event_revision_id_fork_mirror_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."fork_mirror_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_revision" ADD CONSTRAINT "fork_mirror_revision_mirror_id_fork_mirror_id_fk" FOREIGN KEY ("mirror_id") REFERENCES "public"."fork_mirror"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_revision" ADD CONSTRAINT "fork_mirror_revision_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_revision" ADD CONSTRAINT "fork_mirror_revision_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_revision" ADD CONSTRAINT "fork_mirror_revision_rp_id_fork_recovery_point_id_fk" FOREIGN KEY ("rp_id") REFERENCES "public"."fork_recovery_point"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_revision" ADD CONSTRAINT "fork_mirror_revision_plan_id_fork_restore_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."fork_restore_plan"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_revision" ADD CONSTRAINT "fork_mirror_revision_runner_agent_id_agents_id_fk" FOREIGN KEY ("runner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_revision" ADD CONSTRAINT "fork_mirror_revision_probe_task_id_fork_agent_task_id_fk" FOREIGN KEY ("probe_task_id") REFERENCES "public"."fork_agent_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_task" ADD CONSTRAINT "fork_mirror_task_revision_id_fork_mirror_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."fork_mirror_revision"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_mirror_task" ADD CONSTRAINT "fork_mirror_task_task_id_fork_agent_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."fork_agent_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fork_mirror_org_name_uq" ON "fork_mirror" USING btree ("organization_id","name") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "fork_mirror_stack_idx" ON "fork_mirror" USING btree ("stack_id","created_at");--> statement-breakpoint
CREATE INDEX "fork_mirror_event_mirror_at_idx" ON "fork_mirror_event" USING btree ("mirror_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "fork_mirror_revision_one_active_runner_uq" ON "fork_mirror_revision" USING btree ("runner_agent_id") WHERE state IN ('requested','planning','validating','staging','restoring_files','transforming','restoring_db','starting','healthchecking') AND runner_agent_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fork_mirror_revision_port_runner_uq" ON "fork_mirror_revision" USING btree ("runner_agent_id","host_port") WHERE runner_agent_id IS NOT NULL AND coalesce(wipe_state, '') NOT IN ('verified','not_needed');--> statement-breakpoint
CREATE INDEX "fork_mirror_revision_start_tested_idx" ON "fork_mirror_revision" USING btree ("stack_id","readied_at") WHERE state = 'ready' AND readied_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "fork_mirror_revision_mirror_idx" ON "fork_mirror_revision" USING btree ("mirror_id","seq");--> statement-breakpoint
ALTER TABLE "fork_stack" ADD CONSTRAINT "fork_stack_mirror_opt_in_ck" CHECK (("fork_stack"."mirror_opt_in_at" IS NULL) = ("fork_stack"."mirror_opt_in_by" IS NULL));--> statement-breakpoint
ALTER TABLE "fork_restore_plan" ADD CONSTRAINT "fork_restore_plan_purpose_ck" CHECK ("purpose" IN ('restore', 'test_restore', 'mirror'));