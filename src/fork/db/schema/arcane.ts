import {boolean, check, index, jsonb, pgTable, text, timestamp, unique, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {organization} from "@/db/schema/03_organization";
import {agent} from "@/db/schema/08_agent";
import {HEALTH_STATUSES, HOST_ROLES, inList, SYNC_STATUSES, nullOrInList} from "@/fork/db/enums";

const ts = (name: string) => timestamp(name, {withTimezone: true});

/**
 * Arcane connection (instance level, single operator — D21/D35).
 * `api_key_enc` = fork-KEK envelope `{kid, iv, ct, tag}` with AAD `fork_arcane_connection|<id>|api_key_enc` (D23).
 * It must never be selected into a DTO: use `@/fork/db/dto` (allowlist).
 */
export const forkArcaneConnection = pgTable("fork_arcane_connection", {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organization.id, {onDelete: "cascade"}),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEnc: jsonb("api_key_enc").notNull(),
    pinnedApiVersion: text("pinned_api_version"),
    healthStatus: text("health_status").notNull().default("unknown"),
    lastErrorClass: text("last_error_class"),
    /** W05 (SEC-10): per-connection TLS-verification opt-out — explicit, audited, warned in the UI. Default = verify. */
    tlsInsecure: boolean("tls_insecure").notNull().default(false),
    /** W05 (ADR-002 A3): tier-2 opt-in (`projects:read` allowed on the key). System admin, audited. */
    allowProjectsRead: boolean("allow_projects_read").notNull().default(false),
    /** W05: Arcane's id of this key (non-secret), for the permission self-test and rotation tracking. */
    keyId: text("key_id"),
    lastCheckedAt: ts("last_checked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
    unique("fork_arcane_connection_org_name_uq").on(t.organizationId, t.name),
    check("fork_arcane_connection_health_ck", inList("health_status", HEALTH_STATUSES)),
    check("fork_arcane_connection_name_ck", sql`char_length(${t.name}) BETWEEN 1 AND 128`),
]);

/**
 * Arcane environment. `host_role` is written by a system admin only (SEC-11); new rows are `production` (D44).
 * `agent_id` → agents is ON DELETE SET NULL (D32) and `agent_name` keeps the row meaningful afterwards.
 */
export const forkArcaneEnvironment = pgTable("fork_arcane_environment", {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").notNull().references(() => forkArcaneConnection.id, {onDelete: "cascade"}),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    hostRole: text("host_role").notNull().default("production"),
    agentId: uuid("agent_id").references(() => agent.id, {onDelete: "set null"}),
    agentName: text("agent_name"),
    allowedPathRoots: text("allowed_path_roots").array().notNull().default(sql`'{}'::text[]`),
    lastSyncAt: ts("last_sync_at"),
    lastSyncStatus: text("last_sync_status"),
    lastSyncErrorClass: text("last_sync_error_class"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
    unique("fork_arcane_environment_conn_ext_uq").on(t.connectionId, t.externalId),
    index("fork_arcane_environment_agent_idx").on(t.agentId),
    check("fork_arcane_environment_host_role_ck", inList("host_role", HOST_ROLES)),
    check("fork_arcane_environment_sync_status_ck", nullOrInList("last_sync_status", SYNC_STATUSES)),
]);
