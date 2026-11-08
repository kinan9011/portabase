CREATE TABLE "fork_restore_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"yml_present" boolean DEFAULT false NOT NULL,
	"yml_bytes" integer DEFAULT 0 NOT NULL,
	"values_enc" jsonb NOT NULL,
	"restore_id" uuid,
	"render_task_id" uuid,
	"frozen_at" timestamp with time zone,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "fork_restore_override_plan_id_unique" UNIQUE("plan_id"),
	CONSTRAINT "fork_restore_override_hash_ck" CHECK ("fork_restore_override"."plan_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "fork_restore_override_size_ck" CHECK (octet_length("fork_restore_override"."values_enc"::text) <= 262144),
	CONSTRAINT "fork_restore_override_rev_ck" CHECK ("fork_restore_override"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "fork_restore_override" ADD CONSTRAINT "fork_restore_override_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_override" ADD CONSTRAINT "fork_restore_override_plan_id_fork_restore_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."fork_restore_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_restore_override" ADD CONSTRAINT "fork_restore_override_render_task_id_fork_agent_task_id_fk" FOREIGN KEY ("render_task_id") REFERENCES "public"."fork_agent_task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_restore_override_expiry_idx" ON "fork_restore_override" USING btree ("expires_at");