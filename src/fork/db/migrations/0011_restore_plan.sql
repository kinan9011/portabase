CREATE TABLE "fork_restore_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stack_id" uuid NOT NULL,
	"rp_id" uuid,
	"rp_sequence" bigint NOT NULL,
	"target_agent_id" uuid,
	"target_agent_name" text NOT NULL,
	"purpose" text NOT NULL,
	"mode" text NOT NULL,
	"plan_version" integer NOT NULL,
	"mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan" jsonb NOT NULL,
	"plan_hash" text NOT NULL,
	"inputs_digest" text NOT NULL,
	"outcome" text NOT NULL,
	"approvals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fork_restore_plan_purpose_ck" CHECK ("purpose" IN ('restore', 'test_restore')),
	CONSTRAINT "fork_restore_plan_mode_ck" CHECK ("mode" IN ('selective', 'new_stack', 'existing_stack')),
	CONSTRAINT "fork_restore_plan_outcome_ck" CHECK ("outcome" IN ('ready', 'blocked')),
	CONSTRAINT "fork_restore_plan_hash_ck" CHECK ("fork_restore_plan"."plan_hash" ~ '^[0-9a-f]{64}$' AND "fork_restore_plan"."inputs_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "fork_restore_plan_size_ck" CHECK (octet_length("fork_restore_plan"."plan"::text) <= 1048576),
	CONSTRAINT "fork_restore_plan_expiry_ck" CHECK ("fork_restore_plan"."expires_at" > "fork_restore_plan"."created_at")
);
--> statement-breakpoint
ALTER TABLE "fork_stack" ADD COLUMN "contains_personal_data" boolean;--> statement-breakpoint
ALTER TABLE "fork_stack" ADD COLUMN "test_restore_opt_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_stack" ADD COLUMN "test_restore_opt_in_by" text;--> statement-breakpoint
ALTER TABLE "fork_restore_plan" ADD CONSTRAINT "fork_restore_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_plan" ADD CONSTRAINT "fork_restore_plan_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_plan" ADD CONSTRAINT "fork_restore_plan_rp_id_fork_recovery_point_id_fk" FOREIGN KEY ("rp_id") REFERENCES "public"."fork_recovery_point"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_plan" ADD CONSTRAINT "fork_restore_plan_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_restore_plan_stack_idx" ON "fork_restore_plan" USING btree ("stack_id","created_at");--> statement-breakpoint
CREATE INDEX "fork_restore_plan_hash_idx" ON "fork_restore_plan" USING btree ("plan_hash");--> statement-breakpoint
ALTER TABLE "fork_stack" ADD CONSTRAINT "fork_stack_opt_in_ck" CHECK (("fork_stack"."test_restore_opt_in_at" IS NULL) = ("fork_stack"."test_restore_opt_in_by" IS NULL));