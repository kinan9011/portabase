ALTER TABLE "fork_arcane_connection" ADD COLUMN "last_sync_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_arcane_connection" ADD COLUMN "sync_failure_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_arcane_connection" ADD COLUMN "circuit_open_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_arcane_environment" ADD COLUMN "last_sync_summary" jsonb;--> statement-breakpoint
ALTER TABLE "fork_arcane_connection" ADD CONSTRAINT "fork_arcane_connection_streak_ck" CHECK ("fork_arcane_connection"."sync_failure_streak" >= 0);