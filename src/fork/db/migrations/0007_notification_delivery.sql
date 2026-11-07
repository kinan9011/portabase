CREATE TABLE "fork_alert_state" (
	"stack_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fork_alert_state_stack_id_kind_pk" PRIMARY KEY("stack_id","kind"),
	CONSTRAINT "fork_alert_state_epoch_ck" CHECK ("fork_alert_state"."epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "fork_notification_outbox" DROP CONSTRAINT "fork_notification_outbox_state_ck";--> statement-breakpoint
ALTER TABLE "fork_notification_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_notification_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "fork_notification_outbox" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fork_notification_outbox" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "fork_alert_state" ADD CONSTRAINT "fork_alert_state_stack_id_fork_stack_id_fk" FOREIGN KEY ("stack_id") REFERENCES "public"."fork_stack"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fork_notification_outbox" ADD CONSTRAINT "fork_notification_outbox_attempts_ck" CHECK ("fork_notification_outbox"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "fork_notification_outbox" ADD CONSTRAINT "fork_notification_outbox_state_ck" CHECK ("state" IN ('pending', 'delivered', 'failed', 'suppressed'));