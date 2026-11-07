ALTER TABLE "fork_stack_policy" ADD COLUMN "schedule" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "accepted_exclusions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD COLUMN "activation" jsonb DEFAULT '{}'::jsonb NOT NULL;