import {boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {organization} from "@/db/schema/03_organization";
import {forkAgentTask} from "@/fork/db/schema/agent-channel";
import {forkRestorePlan} from "@/fork/db/schema/restore";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * W16b (D28, SEC-08, ADR-014/015 notes): restore-time overrides — per-key env values + one compose override file — for ONE restore plan.
 * `values_enc` is a fork-KEK envelope (AAD `fork_restore_override|<id>|values_enc`) holding `{v:1, env:[{service,key,value}], yml}`; every other
 * column is names/flags/sizes only. Bound to the plan (`plan_id` UNIQUE + `plan_hash`), to one `restore_id` and one render (`render_task_id`),
 * frozen once a data-changing task is enqueued, deleted at cleanup / plan expiry (FK cascade when the plan row goes).
 */
export const forkRestoreOverride = pgTable("fork_restore_override", {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organization.id, {onDelete: "cascade"}),
    planId: uuid("plan_id").notNull().unique().references(() => forkRestorePlan.id, {onDelete: "cascade"}),
    planHash: text("plan_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    /** `[{service,key}]` sorted — names only. */
    envKeys: jsonb("env_keys").notNull().default(sql`'[]'::jsonb`),
    ymlPresent: boolean("yml_present").notNull().default(false),
    ymlBytes: integer("yml_bytes").notNull().default(0),
    valuesEnc: jsonb("values_enc").notNull(),
    restoreId: uuid("restore_id"),
    renderTaskId: uuid("render_task_id").references(() => forkAgentTask.id, {onDelete: "set null"}),
    frozenAt: ts("frozen_at"),
    updatedBy: text("updated_by").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    expiresAt: ts("expires_at").notNull(),
}, (t) => [
    index("fork_restore_override_expiry_idx").on(t.expiresAt),
    check("fork_restore_override_hash_ck", sql`${t.planHash} ~ '^[0-9a-f]{64}$'`),
    check("fork_restore_override_size_ck", sql`octet_length(${t.valuesEnc}::text) <= 262144`),
    check("fork_restore_override_rev_ck", sql`${t.revision} >= 1`),
]);
