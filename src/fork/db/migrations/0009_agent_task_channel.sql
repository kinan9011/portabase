CREATE TABLE "fork_agent_enrollment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"enroll_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"credential_hash" text NOT NULL,
	"prev_credential_hash" text,
	"prev_valid_until" timestamp with time zone,
	"task_key_enc" jsonb NOT NULL,
	"pinned_kids" text[] DEFAULT '{}'::text[] NOT NULL,
	"pin_fingerprint" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"channel_version" integer DEFAULT 1 NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"capabilities_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"enrolled_by" text NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_agent_enrollment_agent_id_unique" UNIQUE("agent_id"),
	CONSTRAINT "fork_agent_enrollment_hash_ck" CHECK ("fork_agent_enrollment"."credential_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "fork_agent_enrollment_prev_ck" CHECK (("fork_agent_enrollment"."prev_credential_hash" IS NULL) = ("fork_agent_enrollment"."prev_valid_until" IS NULL)),
	CONSTRAINT "fork_agent_enrollment_seq_ck" CHECK ("fork_agent_enrollment"."next_seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fork_agent_hash_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_id" uuid,
	"agent_id" uuid,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_agent_hash_report_backup_uq" UNIQUE("backup_id"),
	CONSTRAINT "fork_agent_hash_report_sha_ck" CHECK ("fork_agent_hash_report"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "fork_agent_hash_report_size_ck" CHECK ("fork_agent_hash_report"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fork_agent_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"agent_name" text NOT NULL,
	"enroll_id" uuid NOT NULL,
	"type" text NOT NULL,
	"requires" text[] DEFAULT '{}'::text[] NOT NULL,
	"seq" integer NOT NULL,
	"envelope_text" text NOT NULL,
	"signature" text NOT NULL,
	"kid" text NOT NULL,
	"payload_enc" text,
	"payload_sha256" text NOT NULL,
	"target_agent_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_id" uuid,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "fork_agent_task_enroll_seq_uq" UNIQUE("enroll_id","seq"),
	CONSTRAINT "fork_agent_task_status_ck" CHECK ("status" IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'rejected', 'expired', 'cancelled')),
	CONSTRAINT "fork_agent_task_lease_ck" CHECK ("fork_agent_task"."status" NOT IN ('leased', 'running') OR ("fork_agent_task"."lease_id" IS NOT NULL AND "fork_agent_task"."lease_until" IS NOT NULL)),
	CONSTRAINT "fork_agent_task_final_ck" CHECK ("fork_agent_task"."status" NOT IN ('succeeded', 'failed', 'rejected', 'expired', 'cancelled') OR "fork_agent_task"."finished_at" IS NOT NULL),
	CONSTRAINT "fork_agent_task_result_ck" CHECK ("fork_agent_task"."result" IS NULL OR octet_length("fork_agent_task"."result"::text) <= 65536),
	CONSTRAINT "fork_agent_task_hash_ck" CHECK ("fork_agent_task"."payload_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fork_agent_enrollment" ADD CONSTRAINT "fork_agent_enrollment_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_agent_hash_report" ADD CONSTRAINT "fork_agent_hash_report_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_agent_hash_report" ADD CONSTRAINT "fork_agent_hash_report_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_agent_task" ADD CONSTRAINT "fork_agent_task_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_agent_task_agent_status_idx" ON "fork_agent_task" USING btree ("agent_id","status","seq");