CREATE TABLE "fork_runner" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"designated_by" text NOT NULL,
	"designated_at" timestamp with time zone NOT NULL,
	"probe_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_probe_task_id" uuid,
	"last_probe_targets" jsonb,
	"last_probe_config_sha256" text,
	"last_probe_requested_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_runner_targets_ck" CHECK (octet_length("fork_runner"."probe_targets"::text) <= 16384 AND jsonb_typeof("fork_runner"."probe_targets") = 'array'),
	CONSTRAINT "fork_runner_last_targets_ck" CHECK ("fork_runner"."last_probe_targets" IS NULL OR octet_length("fork_runner"."last_probe_targets"::text) <= 16384),
	CONSTRAINT "fork_runner_sha_ck" CHECK ("fork_runner"."last_probe_config_sha256" IS NULL OR "fork_runner"."last_probe_config_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fork_runner" ADD CONSTRAINT "fork_runner_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_runner" ADD CONSTRAINT "fork_runner_last_probe_task_id_fork_agent_task_id_fk" FOREIGN KEY ("last_probe_task_id") REFERENCES "public"."fork_agent_task"("id") ON DELETE set null ON UPDATE no action;