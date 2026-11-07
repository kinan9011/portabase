CREATE TABLE "fork_dashboard_db_source" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"database_id" uuid,
	"declared_by" text NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_dashboard_db_source_singleton_ck" CHECK ("fork_dashboard_db_source"."singleton" = true)
);
--> statement-breakpoint
CREATE TABLE "fork_kit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"signing_kid" text NOT NULL,
	"kek_kids" text[] DEFAULT '{}'::text[] NOT NULL,
	"types" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_type" text,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"epoch" integer DEFAULT 1 NOT NULL,
	"stale_reason" text,
	"last_checked_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "fork_kit_status_ck" CHECK ("status" IN ('issued', 'verified', 'stale')),
	CONSTRAINT "fork_kit_verified_type_ck" CHECK ("verified_type" IS NULL OR "verified_type" IN ('paper', 'digital')),
	CONSTRAINT "fork_kit_verified_ck" CHECK ("fork_kit"."status" <> 'verified' OR ("fork_kit"."verified_at" IS NOT NULL AND "fork_kit"."verified_type" IS NOT NULL)),
	CONSTRAINT "fork_kit_attempts_ck" CHECK ("fork_kit"."failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fork_kit_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "fork_kit_token_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "fork_kit_token_kind_ck" CHECK ("kind" IN ('paper', 'digital'))
);
--> statement-breakpoint
CREATE TABLE "fork_trust_anchor" (
	"kid" text PRIMARY KEY NOT NULL,
	"public_key_pem" text NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "fork_trust_anchor_kid_ck" CHECK ("fork_trust_anchor"."kid" ~ '^[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "fork_dashboard_db_source" ADD CONSTRAINT "fork_dashboard_db_source_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fork_kit_current_uq" ON "fork_kit" USING btree ((true)) WHERE "fork_kit"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "fork_kit_token_expiry_idx" ON "fork_kit_token" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fork_trust_anchor_live_uq" ON "fork_trust_anchor" USING btree ((true)) WHERE "fork_trust_anchor"."retired_at" IS NULL;