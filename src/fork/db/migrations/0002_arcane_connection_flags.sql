ALTER TABLE "fork_arcane_connection" ADD COLUMN "tls_insecure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_arcane_connection" ADD COLUMN "allow_projects_read" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_arcane_connection" ADD COLUMN "key_id" text;--> statement-breakpoint
ALTER TABLE "fork_arcane_connection" ADD COLUMN "last_checked_at" timestamp with time zone;