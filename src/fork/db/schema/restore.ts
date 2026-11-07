import {bigint, check, index, integer, jsonb, pgTable, text, timestamp, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {organization} from "@/db/schema/03_organization";
import {agent} from "@/db/schema/08_agent";
import {inList} from "@/fork/db/enums";
import {forkRecoveryPoint} from "@/fork/db/schema/recovery";
import {forkStack} from "@/fork/db/schema/stack";
import {PLAN_OUTCOMES, RESTORE_MODES, RESTORE_PURPOSES} from "@/fork/restore/vocab";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * W16 (ADR-014): hash-bound restore plans (dry-run, no side effect). Immutable after insert EXCEPT `approvals` (approvals are not part of
 * the hash; each records the hash it approved). `rp_id` / `target_agent_id` are volatile upstream references: SET NULL (D32), the plan
 * keeps `rp_sequence` / `target_agent_name` denormalised. `plan` is the strict `RestorePlanV1`; `mappings` is the validated non-secret request echo.
 */
export const forkRestorePlan = pgTable("fork_restore_plan", {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organization.id, {onDelete: "cascade"}),
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "cascade"}),
    rpId: uuid("rp_id").references(() => forkRecoveryPoint.id, {onDelete: "set null"}),
    rpSequence: bigint("rp_sequence", {mode: "number"}).notNull(),
    targetAgentId: uuid("target_agent_id").references(() => agent.id, {onDelete: "set null"}),
    targetAgentName: text("target_agent_name").notNull(),
    purpose: text("purpose").notNull(),
    mode: text("mode").notNull(),
    planVersion: integer("plan_version").notNull(),
    mappings: jsonb("mappings").notNull().default(sql`'{}'::jsonb`),
    plan: jsonb("plan").notNull(),
    planHash: text("plan_hash").notNull(),
    inputsDigest: text("inputs_digest").notNull(),
    outcome: text("outcome").notNull(),
    approvals: jsonb("approvals").notNull().default(sql`'[]'::jsonb`),
    createdBy: text("created_by").notNull(),
    createdAt: ts("created_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
}, (t) => [
    index("fork_restore_plan_stack_idx").on(t.stackId, t.createdAt),
    index("fork_restore_plan_hash_idx").on(t.planHash),
    check("fork_restore_plan_purpose_ck", inList("purpose", RESTORE_PURPOSES)),
    check("fork_restore_plan_mode_ck", inList("mode", RESTORE_MODES)),
    check("fork_restore_plan_outcome_ck", inList("outcome", PLAN_OUTCOMES)),
    check("fork_restore_plan_hash_ck", sql`${t.planHash} ~ '^[0-9a-f]{64}$' AND ${t.inputsDigest} ~ '^[0-9a-f]{64}$'`),
    check("fork_restore_plan_size_ck", sql`octet_length(${t.plan}::text) <= 1048576`),
    check("fork_restore_plan_expiry_ck", sql`${t.expiresAt} > ${t.createdAt}`),
]);
