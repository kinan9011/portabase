CREATE TABLE "fork_arcane_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" jsonb NOT NULL,
	"pinned_api_version" text,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_arcane_connection_org_name_uq" UNIQUE("organization_id","name"),
	CONSTRAINT "fork_arcane_connection_health_ck" CHECK ("health_status" IN ('unknown', 'healthy', 'degraded', 'unreachable', 'auth_failed')),
	CONSTRAINT "fork_arcane_connection_name_ck" CHECK (char_length("fork_arcane_connection"."name") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "fork_arcane_environment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"host_role" text DEFAULT 'production' NOT NULL,
	"agent_id" uuid,
	"agent_name" text,
	"allowed_path_roots" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_arcane_environment_conn_ext_uq" UNIQUE("connection_id","external_id"),
	CONSTRAINT "fork_arcane_environment_host_role_ck" CHECK ("host_role" IN ('production', 'test')),
	CONSTRAINT "fork_arcane_environment_sync_status_ck" CHECK ("last_sync_status" IS NULL OR "last_sync_status" IN ('ok', 'partial', 'error'))
);
--> statement-breakpoint
CREATE TABLE "fork_stack" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"environment_id" uuid,
	"environment_name" text NOT NULL,
	"compose_project" text NOT NULL,
	"display_name" text NOT NULL,
	"runtime_state" text DEFAULT 'unknown' NOT NULL,
	"protection_state" text DEFAULT 'unprotected' NOT NULL,
	"project_id" uuid,
	"project_name" text,
	"stale_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_stack_env_project_uq" UNIQUE("environment_id","compose_project"),
	CONSTRAINT "fork_stack_runtime_state_ck" CHECK ("runtime_state" IN ('running', 'partial', 'stopped', 'absent', 'unknown')),
	CONSTRAINT "fork_stack_protection_state_ck" CHECK ("protection_state" IN ('unprotected', 'configured', 'active', 'paused')),
	CONSTRAINT "fork_stack_compose_project_ck" CHECK ("fork_stack"."compose_project" ~ '^[a-z0-9][a-z0-9_-]{0,127}$')
);
--> statement-breakpoint
CREATE TABLE "fork_stack_inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"inventory" jsonb NOT NULL,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_stack_inventory_stack_version_uq" UNIQUE("stack_id","version"),
	CONSTRAINT "fork_stack_inventory_version_ck" CHECK ("fork_stack_inventory"."version" >= 1),
	CONSTRAINT "fork_stack_inventory_hash_ck" CHECK ("fork_stack_inventory"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "fork_stack_policy" (
	"stack_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" text,
	"deactivated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fork_audit_event" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_user_id" text,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"result" text NOT NULL,
	"redacted_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"event_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_audit_event_id_unique" UNIQUE("id"),
	CONSTRAINT "fork_audit_event_event_hash_unique" UNIQUE("event_hash"),
	CONSTRAINT "fork_audit_event_result_ck" CHECK ("result" IN ('success', 'denied', 'failure')),
	CONSTRAINT "fork_audit_event_actor_kind_ck" CHECK ("actor_kind" IN ('user', 'system')),
	CONSTRAINT "fork_audit_event_hash_ck" CHECK ("fork_audit_event"."prev_hash" ~ '^[0-9a-f]{64}$' AND "fork_audit_event"."event_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "fork_lock" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fork_notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "fork_notification_outbox_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "fork_notification_outbox_state_ck" CHECK ("state" IN ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "fork_schedule_state" (
	"stack_id" uuid PRIMARY KEY NOT NULL,
	"last_scheduled_at" timestamp with time zone,
	"last_run_started_at" timestamp with time zone,
	"last_run_finished_at" timestamp with time zone,
	"last_run_status" text,
	"last_verified_rp_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_schedule_state_status_ck" CHECK ("last_run_status" IS NULL OR "last_run_status" IN ('running', 'success', 'partial', 'failed')),
	CONSTRAINT "fork_schedule_state_failures_ck" CHECK ("fork_schedule_state"."consecutive_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fork_recovery_point" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stack_id" uuid NOT NULL,
	"stack_name" text NOT NULL,
	"run_id" uuid,
	"sequence" bigint NOT NULL,
	"inventory_version" integer,
	"inventory_hash" text,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"downgrade_reason" text,
	"consistency_level" text DEFAULT 'unknown' NOT NULL,
	"required_artifact_count" integer DEFAULT 0 NOT NULL,
	"present_artifact_count" integer DEFAULT 0 NOT NULL,
	"total_size_bytes" bigint,
	"manifest_sha256" text,
	"manifest_sig_kid" text,
	"manifest_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verify_report" jsonb,
	"retention_bucket" jsonb,
	"expires_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "fork_recovery_point_stack_seq_uq" UNIQUE("stack_id","sequence"),
	CONSTRAINT "fork_recovery_point_status_ck" CHECK ("status" IN ('incomplete', 'pending_verification', 'verified', 'failed')),
	CONSTRAINT "fork_recovery_point_reason_ck" CHECK ("downgrade_reason" IS NULL OR "downgrade_reason" IN ('fk_null', 'artifact_missing', 'count_mismatch', 'retention_partial', 'stack_removed', 'verify_failed', 'plaintext_hash_mismatch')),
	CONSTRAINT "fork_recovery_point_consistency_ck" CHECK ("consistency_level" IN ('crash_consistent_files', 'engine_dump', 'mixed', 'unknown')),
	CONSTRAINT "fork_recovery_point_counts_ck" CHECK ("fork_recovery_point"."required_artifact_count" >= 0 AND "fork_recovery_point"."present_artifact_count" >= 0),
	CONSTRAINT "fork_recovery_point_verified_ck" CHECK ("fork_recovery_point"."status" <> 'verified' OR ("fork_recovery_point"."verified_at" IS NOT NULL AND "fork_recovery_point"."downgrade_reason" IS NULL)),
	CONSTRAINT "fork_recovery_point_failed_ck" CHECK ("fork_recovery_point"."status" <> 'failed' OR "fork_recovery_point"."downgrade_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "fork_recovery_point_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rp_id" uuid NOT NULL,
	"stack_source_id" uuid,
	"backup_id" uuid,
	"backup_storage_id" uuid,
	"source_name" text NOT NULL,
	"engine" text NOT NULL,
	"dump_format" text,
	"archive_kind" text NOT NULL,
	"archive_format_version" integer,
	"encrypted" boolean NOT NULL,
	"channel_id" uuid,
	"channel_kind" text,
	"path_or_snapshot_id" text,
	"generated_id" text,
	"size_bytes" bigint,
	"ciphertext_sha256" text,
	"plaintext_sha256" text,
	"plaintext_size" bigint,
	"required" boolean DEFAULT true NOT NULL,
	"presence" text DEFAULT 'unknown' NOT NULL,
	CONSTRAINT "fork_rp_artifact_dump_format_ck" CHECK ("dump_format" IS NULL OR "dump_format" IN ('pg_custom', 'pg_directory')),
	CONSTRAINT "fork_rp_artifact_archive_kind_ck" CHECK ("archive_kind" IN ('restic_snapshot', 'archive_enc', 'archive_plain')),
	CONSTRAINT "fork_rp_artifact_presence_ck" CHECK ("presence" IN ('present', 'missing', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "fork_arcane_connection" ADD CONSTRAINT "fork_arcane_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_arcane_environment" ADD CONSTRAINT "fork_arcane_environment_connection_id_fork_arcane_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."fork_arcane_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_arcane_environment" ADD CONSTRAINT "fork_arcane_environment_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack" ADD CONSTRAINT "fork_stack_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack" ADD CONSTRAINT "fork_stack_environment_id_fork_arcane_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."fork_arcane_environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack" ADD CONSTRAINT "fork_stack_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack_inventory" ADD CONSTRAINT "fork_stack_inventory_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_stack_policy" ADD CONSTRAINT "fork_stack_policy_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_schedule_state" ADD CONSTRAINT "fork_schedule_state_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_recovery_point" ADD CONSTRAINT "fork_recovery_point_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_recovery_point_artifact" ADD CONSTRAINT "fork_recovery_point_artifact_rp_id_fork_recovery_point_id_fk" FOREIGN KEY ("rp_id") REFERENCES "public"."fork_recovery_point"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_recovery_point_artifact" ADD CONSTRAINT "fork_recovery_point_artifact_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_recovery_point_artifact" ADD CONSTRAINT "fork_recovery_point_artifact_backup_storage_id_backup_storage_id_fk" FOREIGN KEY ("backup_storage_id") REFERENCES "public"."backup_storage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fork_arcane_environment_agent_idx" ON "fork_arcane_environment" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "fork_stack_org_idx" ON "fork_stack" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "fork_stack_policy_active_idx" ON "fork_stack_policy" USING btree ("stack_id") WHERE activated_at IS NOT NULL AND deactivated_at IS NULL;--> statement-breakpoint
CREATE INDEX "fork_audit_event_created_idx" ON "fork_audit_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "fork_audit_event_org_idx" ON "fork_audit_event" USING btree ("organization_id","seq");--> statement-breakpoint
CREATE INDEX "fork_recovery_point_stack_status_idx" ON "fork_recovery_point" USING btree ("stack_id","status");--> statement-breakpoint
CREATE INDEX "fork_rp_artifact_rp_idx" ON "fork_recovery_point_artifact" USING btree ("rp_id");--> statement-breakpoint
CREATE INDEX "fork_rp_artifact_backup_idx" ON "fork_recovery_point_artifact" USING btree ("backup_id");
--> statement-breakpoint
-- SEC-07 (hand-appended; drizzle-kit does not model triggers): fork_audit_event is append-only.
-- DELETE is allowed only inside the retention transaction (`SET LOCAL fork.audit_retention = 'on'`, see src/fork/audit.ts).
CREATE FUNCTION "fork_audit_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
	IF TG_OP = 'DELETE' AND current_setting('fork.audit_retention', true) = 'on' THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'fork_audit_event is append-only (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;--> statement-breakpoint
CREATE TRIGGER "fork_audit_event_append_only" BEFORE UPDATE OR DELETE ON "fork_audit_event" FOR EACH ROW EXECUTE FUNCTION "fork_audit_guard"();--> statement-breakpoint
CREATE TRIGGER "fork_audit_event_no_truncate" BEFORE TRUNCATE ON "fork_audit_event" FOR EACH STATEMENT EXECUTE FUNCTION "fork_audit_guard"();
