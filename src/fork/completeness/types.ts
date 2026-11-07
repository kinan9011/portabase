/**
 * Completeness + protection model (W09, REVISED-PLAN §4.6, ADR-004 §12). Pure types: no React, no I/O.
 * Every value set here is closed: `labels.ts` must carry copy for each member (a unit test enforces it).
 */

/** Status of one REQUIRED resource. `complete` is true only when none is in {@link GAP_STATUSES}. */
export const ITEM_STATUSES = ["captured", "missing", "inaccessible", "unsupported", "external", "excluded", "accepted_exclusion", "unknown"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/** Statuses that mean "a required resource is not safely covered". `unknown` is a gap on purpose: unknown never counts as complete. */
export const GAP_STATUSES: readonly ItemStatus[] = ["missing", "inaccessible", "unsupported", "unknown"];

export const ITEM_KINDS = ["compose_file", "env_file", "bind", "volume", "anonymous_volume", "database", "image", "network", "dependency", "member_source", "agent", "policy"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Why an item has its status. Closed vocabulary: the UI looks the sentence up in `labels.ts`, never prints a raw code alone. */
export const REASON_CODES = [
    "captured", "captured_manual", "db_file_copy_only",
    "not_covered", "compose_location_unknown", "file_absent",
    "unreadable", "probe_pending", "env_files_undetermined", "env_implicit_unknown",
    "denied_path", "outside_allowed_roots", "volume_driver", "image_local", "anonymous_volume",
    "external_volume", "external_network", "external_dependency",
    "excluded_by_label", "accepted",
    // W10 (materializer): problems of the sources/agent/policy themselves, not of an inventory resource.
    "agent_poll_failing", "agent_unavailable", "source_drifted", "encryption_off", "inventory_changed",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const SEVERITIES = ["blocker", "warn", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What covers a resource (W10 feeds this; W09 callers pass `{}`). */
export type CoverageKind = "engine_dump" | "files" | "manual_files";
/** Agent probe results (W10). A missing entry = not probed = unknown. */
export type ProbeResult = "readable" | "unreadable" | "absent";

/** W10: a problem with the stack's own member sources / agent / policy, fed by the materializer's persisted state (never invented by the validator). */
export type SourceIssue = {
    key: string;
    kind: "member_source" | "agent" | "policy";
    /** Source member name or culprit source names: hint data rendered as text only. */
    name: string;
    reason: Extract<ReasonCode, "agent_poll_failing" | "agent_unavailable" | "source_drifted" | "encryption_off" | "inventory_changed">;
    status: Extract<ItemStatus, "inaccessible" | "unknown" | "unsupported">;
    severity: Severity;
    /** Names of the other stacks the same agent problem affects (names only). */
    consumers?: readonly string[];
};

export type CompletenessContext = {
    /** key → what covers it. Keys: `file:<path>`, `env:<path>`, `mount:<id>`, `volume:<name>`, `db:<service>`, `image:<service>`. */
    coverage: Readonly<Record<string, CoverageKind>>;
    probes: Readonly<Record<string, ProbeResult>>;
    /** Operator-accepted gaps (UX-20), by item key. */
    acceptedExclusions: readonly string[];
    /** `fork_arcane_environment.allowed_path_roots`; empty = none configured (only the hard deny list applies). */
    allowedRoots: readonly string[];
    /** W10: materializer findings; absent = none. Each becomes an item (a blocker is a gap ⇒ never complete). */
    sourceIssues?: readonly SourceIssue[];
};
export const EMPTY_CONTEXT: CompletenessContext = {coverage: {}, probes: {}, acceptedExclusions: [], allowedRoots: [], sourceIssues: []};

export type Item = {
    key: string;
    kind: ItemKind;
    /** Display name: a path hint, a volume/service name. Hint data (SEC-22), rendered as text only. */
    name: string;
    status: ItemStatus;
    reason: ReasonCode;
    severity: Severity;
    /** true when the item stops the stack from being complete. */
    gap: boolean;
    /** A manual source (D19, W11 step 1) can resolve it. */
    resolvable: boolean;
    consumers: readonly string[];
    /** Compose / env files: under the stack's working directory (managed here) or referenced from outside. */
    placement: "here" | "outside" | null;
    /** DBs only: how the data is saved. */
    consistency: "engine_dump" | "files_only" | null;
};

/** §4.4 deny-list directives (informational; restore refuses them without an override) and system paths. */
export const DIRECTIVE_CODES = ["privileged", "host_network", "shared_netns", "docker_socket", "system_path"] as const;
export type DirectiveCode = (typeof DIRECTIVE_CODES)[number];
export type Directive = {code: DirectiveCode; service: string | null; detail: string | null};

export type NetworkMeta = {name: string; ownership: "stack_owned" | "shared_external" | "manual"; subnets: readonly string[]};

export type CompletenessReport = {
    /** True only when no required resource is missing, inaccessible, unsupported or unknown. */
    complete: boolean;
    items: Item[];
    blockers: Item[];
    directives: Directive[];
    networks: NetworkMeta[];
    fileCopyOnlyDatabases: string[];
    counts: {total: number; captured: number; gaps: number; blockers: number; warnings: number; external: number; excluded: number; accepted: number};
};

// ---- protection (§4.6) -------------------------------------------------------------------------------------------
/** Precedence order, highest first. */
export const PRIMARY_STATES = ["failed", "partial", "stale", "kit_not_verified", "awaiting_first_backup", "protected", "unprotected"] as const;
export type PrimaryState = (typeof PRIMARY_STATES)[number];

export const DELETABLE_VALUES = ["yes", "no", "not_checked"] as const;
export type Deletable = (typeof DELETABLE_VALUES)[number];
export const CONSISTENCY_FACETS = ["database_saved_safely", "files_copied_running", "app_paused"] as const;
export type ConsistencyFacet = (typeof CONSISTENCY_FACETS)[number];
