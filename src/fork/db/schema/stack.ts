import {check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {organization} from "@/db/schema/03_organization";
import {project} from "@/db/schema/06_project";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {inList, PROTECTION_STATES, RUNTIME_STATES} from "@/fork/db/enums";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * Stack identity = (environment, compose_project label). Arcane disconnect must never delete stacks/RPs, so the
 * environment FK is SET NULL with `environment_name` denormalised. `project_id` (stack-owned Project, D30) SET NULL (D32).
 */
export const forkStack = pgTable("fork_stack", {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organization.id, {onDelete: "cascade"}),
    environmentId: uuid("environment_id").references(() => forkArcaneEnvironment.id, {onDelete: "set null"}),
    environmentName: text("environment_name").notNull(),
    composeProject: text("compose_project").notNull(),
    displayName: text("display_name").notNull(),
    runtimeState: text("runtime_state").notNull().default("unknown"),
    protectionState: text("protection_state").notNull().default("unprotected"),
    projectId: uuid("project_id").references(() => project.id, {onDelete: "set null"}),
    projectName: text("project_name"),
    staleSince: ts("stale_since"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
    unique("fork_stack_env_project_uq").on(t.environmentId, t.composeProject),
    index("fork_stack_org_idx").on(t.organizationId),
    check("fork_stack_runtime_state_ck", inList("runtime_state", RUNTIME_STATES)),
    check("fork_stack_protection_state_ck", inList("protection_state", PROTECTION_STATES)),
    check("fork_stack_compose_project_ck", sql`${t.composeProject} ~ '^[a-z0-9][a-z0-9_-]{0,127}$'`),
]);

/** One row per (stack, version); a new version only when the content hash changes (ADR-004 §4). */
export const forkStackInventory = pgTable("fork_stack_inventory", {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "cascade"}),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    inventory: jsonb("inventory").notNull(),
    provenance: jsonb("provenance").notNull().default(sql`'{}'::jsonb`),
    warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
    discoveredAt: ts("discovered_at").notNull().defaultNow(),
}, (t) => [
    unique("fork_stack_inventory_stack_version_uq").on(t.stackId, t.version),
    check("fork_stack_inventory_version_ck", sql`${t.version} >= 1`),
    check("fork_stack_inventory_hash_ck", sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
]);

/**
 * Activation record (D31). Minimal in W04: the real active-policy probe counts rows with
 * `activated_at IS NOT NULL AND deactivated_at IS NULL`. W11 adds the schedule/config columns.
 * `policy` holds the D33 retention policy v1 (validated by `@/fork/recovery/retention-policy`, W12).
 */
export const forkStackPolicy = pgTable("fork_stack_policy", {
    stackId: uuid("stack_id").primaryKey().references(() => forkStack.id, {onDelete: "cascade"}),
    policy: jsonb("policy").notNull().default(sql`'{}'::jsonb`),
    activatedAt: ts("activated_at"),
    activatedBy: text("activated_by"),
    deactivatedAt: ts("deactivated_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
    index("fork_stack_policy_active_idx").on(t.stackId).where(sql`activated_at IS NOT NULL AND deactivated_at IS NULL`),
]);
