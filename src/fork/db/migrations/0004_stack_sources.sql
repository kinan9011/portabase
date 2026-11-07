CREATE TABLE "fork_stack_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"role" text NOT NULL,
	"resource_key" text NOT NULL,
	"origin" text DEFAULT 'discovered' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"database_id" uuid,
	"dbms" text NOT NULL,
	"engine" text DEFAULT 'archive' NOT NULL,
	"member_name" text NOT NULL,
	"covers_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"desired_hash" text NOT NULL,
	"drift_reason" text,
	"last_probe" text,
	"last_probe_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_stack_source_stack_key_uq" UNIQUE("stack_id","resource_key"),
	CONSTRAINT "fork_stack_source_role_ck" CHECK ("role" IN ('compose', 'env', 'bind', 'volume', 'db')),
	CONSTRAINT "fork_stack_source_origin_ck" CHECK ("origin" IN ('discovered', 'manual')),
	CONSTRAINT "fork_stack_source_status_ck" CHECK ("status" IN ('planned', 'canary', 'active', 'drifted', 'orphaned', 'blocked')),
	CONSTRAINT "fork_stack_source_probe_ck" CHECK ("last_probe" IS NULL OR "last_probe" IN ('readable', 'unreadable')),
	CONSTRAINT "fork_stack_source_hash_ck" CHECK ("fork_stack_source"."desired_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "selection" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "storage_channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "consistency_profile" text DEFAULT 'crash' NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "applied_plan_hash" text;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "materialized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "materialize_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_source" ADD CONSTRAINT "fork_stack_source_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack_source" ADD CONSTRAINT "fork_stack_source_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_stack_source_db_idx" ON "fork_stack_source" USING btree ("database_id");--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD CONSTRAINT "fork_stack_policy_materialize_state_ck" CHECK ("materialize_state" IN ('none', 'ready', 'inventory_changed', 'blocked'));--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD CONSTRAINT "fork_stack_policy_consistency_ck" CHECK ("consistency_profile" IN ('crash', 'dump', 'stop'));