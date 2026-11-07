CREATE TABLE "fork_compose_render" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid,
	"restore_id" uuid NOT NULL,
	"policy_view" text NOT NULL,
	"rendered_sha256" text NOT NULL,
	"raw" jsonb NOT NULL,
	"roots" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"compose_version" text,
	"agent_rules_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_compose_render_size" CHECK (octet_length("fork_compose_render"."policy_view") <= 2097152),
	CONSTRAINT "fork_compose_render_sha" CHECK ("fork_compose_render"."rendered_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fork_compose_render" ADD CONSTRAINT "fork_compose_render_task_id_fork_agent_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."fork_agent_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_compose_render" ADD CONSTRAINT "fork_compose_render_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_compose_render_restore_idx" ON "fork_compose_render" USING btree ("restore_id","created_at");