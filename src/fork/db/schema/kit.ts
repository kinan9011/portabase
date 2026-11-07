import {boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid} from "drizzle-orm/pg-core";
import {sql} from "drizzle-orm";
import {database} from "@/db/schema/07_database";
import {inList, nullOrInList} from "@/fork/db/enums";

const ts = (name: string) => timestamp(name, {withTimezone: true});

export const KIT_STATUSES = ["issued", "verified", "stale"] as const;
export const KIT_TYPES = ["paper", "digital"] as const;

/**
 * Trust anchors (ADR-013 §3): every public key that ever signed a manifest. Rows are NEVER deleted: a retired key keeps verifying the
 * manifests it signed. Public material only.
 */
export const forkTrustAnchor = pgTable("fork_trust_anchor", {
    kid: text("kid").primaryKey(),
    publicKeyPem: text("public_key_pem").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    retiredAt: ts("retired_at"),
}, (t) => [
    check("fork_trust_anchor_kid_ck", sql`${t.kid} ~ '^[0-9a-f]{12}$'`),
    // at most one live anchor
    uniqueIndex("fork_trust_anchor_live_uq").on(sql`(true)`).where(sql`${t.retiredAt} IS NULL`),
]);

/**
 * The recovery kit ISSUE record (ADR-013 §8, D25/D41): NEVER the kit itself. `fingerprint` is the one-way verification code the offline
 * verifier prints (not shown on the kit); `kek_kids` / `signing_kid` name which keys the kit covered. One current row (`superseded_at IS NULL`).
 */
export const forkKit = pgTable("fork_kit", {
    id: uuid("id").primaryKey().defaultRandom(),
    fingerprint: text("fingerprint").notNull(),
    signingKid: text("signing_kid").notNull(),
    kekKids: text("kek_kids").array().notNull().default(sql`'{}'::text[]`),
    types: text("types").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").notNull().default("issued"),
    issuedAt: ts("issued_at").notNull().defaultNow(),
    issuedBy: text("issued_by").notNull(),
    verifiedAt: ts("verified_at"),
    verifiedType: text("verified_type"),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: ts("locked_until"),
    epoch: integer("epoch").notNull().default(1),
    staleReason: text("stale_reason"),
    lastCheckedAt: ts("last_checked_at"),
    supersededAt: ts("superseded_at"),
}, (t) => [
    check("fork_kit_status_ck", inList("status", KIT_STATUSES)),
    check("fork_kit_verified_type_ck", nullOrInList("verified_type", KIT_TYPES)),
    check("fork_kit_verified_ck", sql`${t.status} <> 'verified' OR (${t.verifiedAt} IS NOT NULL AND ${t.verifiedType} IS NOT NULL)`),
    check("fork_kit_attempts_ck", sql`${t.failedAttempts} >= 0`),
    uniqueIndex("fork_kit_current_uq").on(sql`(true)`).where(sql`${t.supersededAt} IS NULL`),
]);

/** Single-use, user-bound, short-lived grants for the kit download/print routes (ADR-013 §K-8). Only a SHA-256 of the token is stored. */
export const forkKitToken = pgTable("fork_kit_token", {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    consumedAt: ts("consumed_at"),
}, (t) => [
    check("fork_kit_token_kind_ck", inList("kind", KIT_TYPES)),
    index("fork_kit_token_expiry_idx").on(t.expiresAt),
]);

/** D40: which upstream source backs up the dashboard database (declared by a system admin; FK SET NULL like every fork FK to upstream tables, D32). One row. */
export const forkDashboardDbSource = pgTable("fork_dashboard_db_source", {
    singleton: boolean("singleton").primaryKey().default(true),
    databaseId: uuid("database_id").references(() => database.id, {onDelete: "set null"}),
    declaredBy: text("declared_by").notNull(),
    declaredAt: ts("declared_at").notNull().defaultNow(),
}, (t) => [check("fork_dashboard_db_source_singleton_ck", sql`${t.singleton} = true`)]);
