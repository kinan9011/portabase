import {bigint, check, index, jsonb, pgTable, text, timestamp, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {AUDIT_ACTOR_KINDS, AUDIT_RESULTS, inList} from "@/fork/db/enums";

/**
 * Append-only audit log (SEC-07). Integrity: per-row SHA-256 hash chain (`prev_hash` → `event_hash`) written under an
 * advisory lock by `recordAudit()`; a DB trigger (see migration 0001) rejects UPDATE/TRUNCATE and DELETE except inside
 * the retention transaction. NO FK to organization on purpose: audit must outlive instance teardown.
 * `redacted_details` is the ONLY free-form column and is always passed through `redactDetails()`.
 */
export const forkAuditEvent = pgTable("fork_audit_event", {
    seq: bigint("seq", {mode: "number"}).primaryKey(),
    id: uuid("id").notNull().unique().defaultRandom(),
    organizationId: uuid("organization_id"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    result: text("result").notNull(),
    redactedDetails: jsonb("redacted_details").notNull().default(sql`'{}'::jsonb`),
    prevHash: text("prev_hash").notNull(),
    eventHash: text("event_hash").notNull().unique(),
    createdAt: timestamp("created_at", {withTimezone: true}).notNull().defaultNow(),
}, (t) => [
    index("fork_audit_event_created_idx").on(t.createdAt),
    index("fork_audit_event_org_idx").on(t.organizationId, t.seq),
    check("fork_audit_event_result_ck", inList("result", AUDIT_RESULTS)),
    check("fork_audit_event_actor_kind_ck", inList("actor_kind", AUDIT_ACTOR_KINDS)),
    check("fork_audit_event_hash_ck", sql`${t.prevHash} ~ '^[0-9a-f]{64}$' AND ${t.eventHash} ~ '^[0-9a-f]{64}$'`),
]);
