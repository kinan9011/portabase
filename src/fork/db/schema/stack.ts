import {boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {organization} from "@/db/schema/03_organization";
import {project} from "@/db/schema/06_project";
import {database} from "@/db/schema/07_database";
import {forkArcaneEnvironment} from "@/fork/db/schema/arcane";
import {
    inList, MATERIALIZE_STATES, nullOrInList, PROTECTION_STATES, RUNTIME_STATES, SOURCE_ORIGINS, SOURCE_PROBES, SOURCE_ROLES, SOURCE_STATUSES,
} from "@/fork/db/enums";

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
    /** W10: the operator's selection (resource keys, hints carried for W17b, non-secret DB connection fields). NEVER a password (D31). */
    selection: jsonb("selection").notNull().default(sql`'{}'::jsonb`),
    /** W10: project-level storage channels the stack Project was given. Copied ids (no FK, D32); the self-check reads them. */
    storageChannelIds: uuid("storage_channel_ids").array().notNull().default(sql`'{}'::uuid[]`),
    consistencyProfile: text("consistency_profile").notNull().default("crash"),
    /** W10: hash of the plan the current sources were applied from; a different plan hash for the latest inventory = inventory drift. */
    appliedPlanHash: text("applied_plan_hash"),
    materializedAt: ts("materialized_at"),
    materializeState: text("materialize_state").notNull().default("none"),
    /** W11: validated `ScheduleV1` (`@/fork/schedule/schedule`): preset + timezone (+ `cron` only for preset `cron`); the effective cron is always derived by `toCron` (W12 scheduler reads it). */
    schedule: jsonb("schedule").notNull().default(sql`'{}'::jsonb`),
    /** W11: operator-accepted gaps (UX-20), by completeness item key. Written only by `activateStackPolicy`. */
    acceptedExclusions: text("accepted_exclusions").array().notNull().default(sql`'{}'::text[]`),
    /** W11: D31 authorization record at activation: ids + capability names only (never a secret). `{}` until activated. */
    activation: jsonb("activation").notNull().default(sql`'{}'::jsonb`),
}, (t) => [
    index("fork_stack_policy_active_idx").on(t.stackId).where(sql`activated_at IS NOT NULL AND deactivated_at IS NULL`),
    check("fork_stack_policy_materialize_state_ck", inList("materialize_state", MATERIALIZE_STATES)),
    check("fork_stack_policy_consistency_ck", inList("consistency_profile", ["crash", "dump", "stop"])),
]);

/**
 * W10: one row per materialized member source of a stack. `resource_key` is the W09 completeness key the source covers
 * (`file:<path>`, `mount:<id>`, `volume:<name>`, `db:<service>`, …). `database_id` → upstream `databases` is ON DELETE SET NULL (D32):
 * a vanished upstream row never deletes the link, it makes it `drifted`. Non-secret `desired_hash` only — no config copy, no password.
 */
export const forkStackSource = pgTable("fork_stack_source", {
    id: uuid("id").primaryKey().defaultRandom(),
    stackId: uuid("stack_id").notNull().references(() => forkStack.id, {onDelete: "cascade"}),
    role: text("role").notNull(),
    resourceKey: text("resource_key").notNull(),
    origin: text("origin").notNull().default("discovered"),
    required: boolean("required").notNull().default(true),
    status: text("status").notNull().default("planned"),
    databaseId: uuid("database_id").references(() => database.id, {onDelete: "set null"}),
    dbms: text("dbms").notNull(),
    engine: text("engine").notNull().default("archive"),
    memberName: text("member_name").notNull(),
    /** Resource keys this member covers (a compose-dir source covers several `file:`/`env:` keys). */
    coversKeys: text("covers_keys").array().notNull().default(sql`'{}'::text[]`),
    desiredHash: text("desired_hash").notNull(),
    driftReason: text("drift_reason"),
    lastProbe: text("last_probe"),
    lastProbeAt: ts("last_probe_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
    unique("fork_stack_source_stack_key_uq").on(t.stackId, t.resourceKey),
    index("fork_stack_source_db_idx").on(t.databaseId),
    check("fork_stack_source_role_ck", inList("role", SOURCE_ROLES)),
    check("fork_stack_source_origin_ck", inList("origin", SOURCE_ORIGINS)),
    check("fork_stack_source_status_ck", inList("status", SOURCE_STATUSES)),
    check("fork_stack_source_probe_ck", nullOrInList("last_probe", SOURCE_PROBES)),
    check("fork_stack_source_hash_ck", sql`${t.desiredHash} ~ '^[0-9a-f]{64}$'`),
]);
