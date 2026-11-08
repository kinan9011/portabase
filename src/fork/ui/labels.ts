import {ARCANE_PINNED_VERSION} from "@/fork/arcane/endpoints";
import type {ArcaneErrorClass} from "@/fork/arcane/errors";
import type {ConsistencyFacet, Deletable, DirectiveCode, ItemKind, ItemStatus, PrimaryState, ReasonCode} from "@/fork/completeness/types";
import type {HostRole} from "@/fork/db/enums";
import type {SourceView} from "@/fork/completeness/view";
import type {Tone} from "@/fork/ui/tone";

/**
 * Single source of every state label / description / error copy shown by fork UI (REVISED-PLAN §8.2 rule 8, UX-11).
 * Rendered as inline text (or `aria-describedby`) — never hover-only. Pure data: no React, no server imports.
 * Rules for copy: say what is true and what to do; never "read-only" for the Arcane key (ADR-002 §6); no URLs, headers or
 * response bodies (the server never gives the browser any); backups and recovery points are never implied to be affected.
 */

// ---- Arcane connection: the 9 states (UX-19) ------------------------------------------------------------------------
export const CONNECTION_STATES = [
    "not_configured", "testing", "connected", "syncing", "partial_sync",
    "invalid_credentials", "insufficient_permission", "unreachable", "incompatible_api",
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type StateLabel = {label: string; description: string; tone: Tone; /** transient: renders a spinner and `aria-busy` */ busy?: boolean};

export const CONNECTION_STATE_LABELS: Record<ConnectionState, StateLabel> = {
    not_configured: {label: "Not configured", tone: "neutral", description: "No Arcane Manager is connected. Nothing is discovered from Arcane and nothing is backed up by this page."},
    testing: {label: "Testing…", tone: "neutral", busy: true, description: "Checking the address, the Arcane version and the key's permissions. If this does not finish, the connection has not been verified yet: run Test connection."},
    connected: {label: "Connected", tone: "success", description: "Arcane answered, the key holds exactly the discovery permissions and every allowed environment was reachable at the last check."},
    syncing: {label: "Syncing…", tone: "active", busy: true, description: "Reading inventory from Arcane."},
    partial_sync: {label: "Partial sync", tone: "warning", description: "Some allowed environments could not be read completely. The others keep working."},
    invalid_credentials: {label: "Invalid credentials", tone: "danger", description: "Arcane did not accept the stored key, or Portabase refuses it. Discovery is paused."},
    insufficient_permission: {label: "Insufficient permission", tone: "danger", description: "The key lacks a permission discovery needs. Discovery is paused for the affected environments."},
    unreachable: {label: "Unreachable", tone: "danger", description: "Portabase could not complete a request to Arcane. Stored inventory is kept."},
    incompatible_api: {label: "Incompatible API", tone: "warning", description: `This release was tested against Arcane ${ARCANE_PINNED_VERSION}. Discovery is paused until a compatible version is used.`},
};

/** Alert shown above the card for the problem states. Keyed by the persisted `last_error_class` (W05, ADR-012 S7). */
export type AlertCopy = {title: string; body: string};
export const CONNECTION_ERROR_COPY: Record<ArcaneErrorClass, AlertCopy> = {
    invalid_key: {title: "Arcane rejected the API key (HTTP 401)", body: "Create a new key in Arcane with only the listed permissions and enter it with Rotate key. Existing backups and recovery points are not affected."},
    key_too_broad: {title: "The API key can do more than discovery needs", body: "In Arcane, container, volume and project read permissions return secrets. Create a new key with only the listed list-permissions and rotate to it; Portabase refuses to use this one."},
    key_unverifiable: {title: "The key's own permissions could not be checked", body: "Portabase refuses a key it cannot verify. Check that the key belongs to an Arcane user who can list their own API keys, then rotate it."},
    permission: {title: "The key lacks a required permission", body: "Arcane answered 403. Grant the listed list-permissions for each environment you want to protect, or leave that environment disabled."},
    partial: {title: "Some environments are not fully covered by the key", body: "The key does not hold the full list-permission set for every environment it covers. Those environments keep their last known state; grant the missing permissions or disable them."},
    unreachable: {title: "Arcane Manager unreachable", body: "The request failed or timed out (10 s limit). Stored inventory is kept. Scheduled backups run through the Portabase agent and are not affected."},
    tls: {title: "The TLS certificate could not be verified", body: "Use a certificate this server trusts. Turning verification off is possible per connection but lets anyone on the network path read the key."},
    blocked_url: {title: "This address is not allowed", body: "Portabase connects to public HTTPS addresses. A private or loopback Arcane needs an entry in the server's operator allow-list (FORK_ARCANE_NET_ALLOWLIST); cloud metadata addresses are never allowed."},
    rate_limited: {title: "Arcane is rate limiting requests", body: "Arcane answered 429 too many times. Wait a minute and run Test connection again."},
    incompatible: {title: "Unsupported Arcane version", body: `This release was tested against Arcane ${ARCANE_PINNED_VERSION}. Discovery is paused until the Manager runs that version.`},
    bad_response: {title: "Arcane answered in an unexpected format", body: "The Arcane API may have changed. Discovery is paused; nothing was changed in Portabase."},
    not_found: {title: "Arcane no longer knows a resource", body: "An environment or key Portabase expected is gone. Run Test connection; environments missing from Arcane stay listed as stale."},
};

// ---- Refusal codes of the connection / environment actions (ADR-012 UX-07) ---------------------------------------------
export const REFUSAL_COPY: Record<string, string> = {
    forbidden: "Only a system administrator can change Stack Recovery configuration.",
    not_found: "That connection or environment no longer exists. Reload the page.",
    locked: "Fork configuration is locked, so nothing was changed.",
    rate_limited: "Too many attempts. Wait a moment and try again.",
    invalid_input: "Check the values you entered.",
    key_reentry_required: "The host, port or scheme changed: enter the API key again. A stored key is never sent to a different endpoint.",
    refused: "Arcane refused the connection; nothing was saved.",
    single_tenant_required: "Stack Recovery needs exactly one organization.",
    already_running: "A sync is already running. It reads the same data; reload to see its result.",
    no_enabled_environment: "Turn on discovery for at least one environment first.",
};
export const GENERIC_FAILURE = "The action failed on the server and nothing was changed. Try again; if it keeps failing check the server log.";

// ---- Environment table ---------------------------------------------------------------------------------------------------
export const HOST_ROLE_LABELS: Record<HostRole, {label: string; description: string}> = {
    production: {label: "Production", description: "Real workloads. Never a target for test restores or mirrors. Default."},
    test: {label: "Test host", description: "A host you approve for data-only test restores. Production data is copied there and wiped afterwards."},
};
export const AGENT_STATUS_LABELS = {online: "Online", degraded: "Degraded", offline: "Offline", none: "No agent mapped"} as const;
export const ENVIRONMENT_COPY = {
    notSynced: "Not synced yet",
    discoveryHelp: "Found means visible in Arcane at the last sync. Protected means an active Portabase backup policy exists (none can exist yet in this release).",
    enableHelp: "Enabled environments are included in discovery.",
    staleEnvironment: "No longer visible to the key. Cached data is kept and marked stale.",
    stale: "Stale: the last sync failed, this is older data.",
    gone: "No longer covered by the Arcane key",
} as const;

export const SYNC_NOW = {
    label: "Sync now",
    pending: "Syncing…",
    noEnvironment: "Turn on discovery for at least one environment first.",
    running: "A sync is already running.",
} as const;

/** Fixed, code-only sync error vocabulary (the summary stores codes, never Arcane text). */
export const SYNC_ERROR_LABELS: Record<string, string> = {
    unreachable: "Arcane could not be reached", invalid_key: "Arcane rejected the key", permission: "A list permission is missing", incompatible: "Arcane version differs from the tested one",
    rate_limited: "Arcane is rate limiting", bad_response: "Unexpected Arcane answer", tls: "Certificate could not be verified", blocked_url: "Address not allowed", not_found: "Environment not visible to the key",
    deadline: "Took longer than 60 s", invalid_project: "A project name was refused", inventory_limit: "A stack exceeded the inventory limits", inventory_invalid: "A stack could not be recorded",
    key_too_broad: "Key holds more than the minimum", key_unverifiable: "Key permissions could not be read", partial: "Some environments failed", internal: "Internal error (see audit log)",
};
export const SYNC_COPY = {
    circuitTitle: "Automatic discovery is paused",
    circuitBody: (failures: number, until: string) => `The last ${failures} syncs failed, so Portabase stopped retrying automatically until ${until}. Sync now tries again at once; a successful sync resumes the schedule.`,
    announce: {
        started: "Syncing…",
        ok: (found: number, changed: number) => `Sync finished: ${found} stack${found === 1 ? "" : "s"} found${changed ? `, ${changed} new or changed` : ", nothing changed"}.`,
        partial: (found: number) => `Sync finished with problems: ${found} stack${found === 1 ? "" : "s"} found. See the environment table.`,
        failed: (why: string) => `Sync failed: ${why}. Cached data was kept and marked stale.`,
    },
} as const;
export const LOCKED_PREFIX = "Fork configuration locked";
export const NON_ADMIN_EXPLANATION = {
    title: "Integrations are managed by a system administrator",
    body: "Stack Recovery connects to an Arcane Manager at instance level. Ask a system administrator to set it up; you do not need to do anything here.",
};
export const SETUP_PATH = {
    title: "Connect your Arcane Manager",
    steps: [
        "In Arcane, create a dedicated API key with only the list permissions shown in the form.",
        "Enter the Manager URL and the key. Portabase checks the version, the key's permissions and every environment before anything is saved.",
        "Enable the environments Portabase should discover and map each to its Portabase agent.",
    ],
};

// ================================================================================================================
// W08 — Docker Stacks list + details. Every state word, empty state, action reason and honesty note of the stacks UI.
// Honest wording (REVISED-PLAN §8.2 / Overview): discovered ≠ backed up ≠ verified ≠ restore-tested. Nothing on these
// pages can say "protected" unless `protection_state` says so, and no recovery point exists before W12.
// ================================================================================================================

export const RUNTIME_LABELS = {
    running: {label: "Running", tone: "success", description: "All services of this stack were running at the last sync. Informational only: it says nothing about backups."},
    partial: {label: "Partially running", tone: "warning", description: "Some services were running and some were not at the last sync. Informational only."},
    stopped: {label: "Stopped", tone: "neutral", description: "No service of this stack was running at the last sync. Informational only."},
    absent: {label: "No longer found", tone: "warning", description: "The last successful sync did not list this stack any more. Its last known inventory is kept."},
    unknown: {label: "Runtime unknown", tone: "neutral", description: "No runtime state has been read for this stack yet."},
} as const satisfies Record<string, {label: string; tone: Tone; description: string}>;
export type RuntimeStateKey = keyof typeof RUNTIME_LABELS;

/** Protection comes from Portabase only (never from Arcane). Before W10/W11 every stack is "Unprotected". */
export const PROTECTION_LABELS = {
    unprotected: {label: "Unprotected", tone: "neutral", description: "No Portabase backup policy is active for this stack. Discovery alone does not back anything up."},
    configured: {label: "Backup configured", tone: "neutral", description: "A backup policy is saved but not active yet."},
    active: {label: "Backup active", tone: "neutral", description: "A backup policy is active. Whether recovery points exist and are verified is shown separately."},
    paused: {label: "Backup paused", tone: "warning", description: "The backup policy is paused. No scheduled backup runs for this stack."},
} as const satisfies Record<string, {label: string; tone: Tone; description: string}>;
export type ProtectionStateKey = keyof typeof PROTECTION_LABELS;

export const STALE_BADGE = {label: "Stale", tone: "warning", description: "The last sync failed, so this is older data."} as const satisfies {label: string; tone: Tone; description: string};

export const STACKS_PAGE = {
    title: "Docker Stacks",
    description: "Compose applications discovered through Arcane. Runtime comes from Arcane; protection comes from Portabase.",
    sourceNote: "Source host and runtime state come from Arcane at the last sync. Protection comes from Portabase: a stack stays Unprotected until a backup policy is active.",
    foundTile: "Found",
    unprotectedTile: "Unprotected",
    staleTile: "Stale or no longer found",
    searchLabel: "Search stacks",
    searchPlaceholder: "Name or project",
    environmentLabel: "Environment",
    runtimeLabel: "Runtime",
    protectionLabel: "Protection",
    sortLabel: "Sort",
    allEnvironments: "All environments",
    allRuntime: "All runtime states",
    allProtection: "All protection states",
    apply: "Apply",
    clear: "Clear filters",
    sortOptions: {name: "Name", attention: "Needs attention", updated: "Recently changed"},
    results: (from: number, to: number, total: number) => `Showing ${from}–${to} of ${total} stack${total === 1 ? "" : "s"}`,
    resultsNone: "No stacks match.",
    previous: "Previous page",
    next: "Next page",
    open: "Open",
    tableCaption: "Discovered Docker stacks with runtime state, resources and protection",
    columns: {stack: "Stack", environment: "Environment", runtime: "Runtime", resources: "Resources", protection: "Protection", latestRp: "Latest recovery point", seen: "Last seen"},
    noRecoveryPoint: "None yet",
    resourceUnits: {services: "services", volumes: "volumes", binds: "bind mounts", networks: "networks", databases: "databases"},
    sharedFlag: (n: number) => `${n} shared`,
    syncing: "Syncing…",
    syncingDone: "Sync finished. The list is up to date.",
} as const;

export const STALE_BANNER = {
    title: "Some inventory may be out of date",
    body: (n: number) => `${n} stack${n === 1 ? "" : "s"} could not be refreshed by the last sync. Cached results are shown and marked stale. Protection status comes from Portabase and is current.`,
    circuit: "Automatic discovery is paused after repeated failures. Cached results are shown.",
    link: "View the integration",
} as const;

/** Role-aware empty states (D35): the same situation reads differently for an administrator and for a member. */
export const STACKS_EMPTY = {
    noConnection: {
        title: "No stacks discovered yet",
        admin: "Connect an Arcane Manager and turn on discovery for at least one environment. Stacks appear here after the first sync.",
        member: "A system administrator has not connected an Arcane Manager yet. Ask them to set up Stack Recovery; nothing is needed from you.",
        adminAction: "Connect Arcane",
    },
    noEnabledEnvironment: {
        title: "Discovery is off for every environment",
        admin: "Arcane is connected, but no environment is enabled for discovery. Turn one on in Integrations, then sync.",
        member: "Arcane is connected but discovery is not turned on yet. A system administrator needs to enable an environment.",
        adminAction: "Open Integrations",
    },
    noStacks: {
        title: "No stacks found yet",
        admin: "Discovery is on but the last sync found no Compose projects. Run Sync now in Integrations, or check that the environment runs Compose projects.",
        member: "Discovery is on but no stacks have been found yet. They appear here after the next sync.",
        adminAction: "Open Integrations",
    },
    filtered: {title: "No stacks match these filters", body: "Change or clear the filters to see more."},
    unauthorized: {title: "You do not have access to Docker Stacks", body: "Stacks are visible to members of the organization. Ask an organization owner or administrator to add you."},
    notReadable: {title: "This stack's inventory could not be read", body: "The stored inventory does not match the version this release understands. Nothing was changed. The next successful sync replaces it."},
    noInventory: {title: "No inventory has been recorded for this stack", body: "The stack is known but no inventory version exists. Run a sync to record one."},
    loadError: {title: "Stacks could not be loaded", body: "The server could not read stack data. Nothing was changed; reload the page."},
    locked: "Fork configuration is locked. You can still look at stacks; configuration actions are paused.",
} as const;

export const STACK_DETAILS = {
    back: "All stacks",
    tabs: {overview: "Overview", resources: "Resources"},
    tabsLabel: "Stack sections",
    lastSync: "Last sync",
    inventoryCaptured: "Inventory captured",
    environment: "Environment",
    composeProject: "Compose project",
    notSynced: "Not synced yet",
    goneBanner: {title: "No longer found in Arcane", body: "The last successful sync did not list this stack. The inventory below is the last known one and may not match what runs now."},
    staleBanner: {title: "This inventory is stale", body: (when: string) => `The last sync failed. The data below was captured ${when} and may be out of date.`},
    notInRelease: "Not in this release",
    actions: {
        configure: {label: "Configure backup", admin: "Backup configuration is locked while Fork configuration is locked.", member: "Only a system administrator configures backups."},
        backupNow: {label: "Back up now"},
        restore: {label: "Restore", reason: "Restoring from the dashboard is planned for release R2."},
        mirror: {label: "Create test mirror", reason: "Test mirrors are not part of this release."},
    },
    overview: {
        resources: "Resource summary",
        recovery: "Latest recovery point",
        noRecovery: "None yet",
        noRecoveryNote: "No backup exists for this stack. Discovery lists resources; it does not back them up.",
        verifiedCount: (n: number) => `${n} verified recovery point${n === 1 ? "" : "s"}`,
        sharedHeading: "Shared with other stacks",
        sharedNone: "No shared resources were detected.",
        sharedNote: "Shared resources are used by more than one stack. Backing up or restoring this stack never changes them.",
        warnings: "Discovery notes",
        noWarnings: "Discovery recorded no notes for this stack.",
        facts: "Discovery details",
        inventoryVersion: "Inventory version",
        composeRead: {none: "Not read (names and paths come from container labels only)", arcane_compose: "Read through Arcane (names only)", agent_files: "Read from the host by the agent"},
        composeReadLabel: "Compose file",
        ports: "Ports",
    },
    resources: {
        heading: "Resources",
        agentNote: "Arcane lists these resources; it cannot read their contents. Bind mounts and volume data are read from the host by the Portabase agent when a backup runs.",
        tabsLabel: "Resource types",
        sections: {services: "Services", volumes: "Named volumes", binds: "Bind mounts", databases: "Databases", networks: "Networks"},
        empty: {services: "No services in the inventory.", volumes: "No named volumes.", binds: "No bind mounts.", databases: "No database was recognised in this stack.", networks: "No networks."},
        columns: {
            service: "Service", image: "Image", state: "State", ports: "Ports", networks: "Networks", mounts: "Mounts",
            volume: "Volume", driver: "Driver", usedBy: "Used by", ownership: "Ownership", destination: "Container path", hostPath: "Host path", access: "Access", consumers: "Used by",
            engine: "Engine", basis: "Detected from", network: "Network", kind: "Kind", members: "Members", flags: "Flags",
        },
        ownership: {stack_owned: "This stack", external_shared: "Shared (external)", unknown: "Unknown"},
        classification: {stack_owned: "This stack", shared_external: "Shared (external)", manual: "Manual / not owned"},
        sharedMarker: "Shared",
        externalMarker: "External",
        anonymousWarning: "Anonymous volume: it is not a named volume and will not be backed up by name.",
        rw: {true: "Read-write", false: "Read-only"},
        imagePinned: "pinned",
        imageUnpinned: "not pinned",
        builtLocally: "built locally",
        privileged: "privileged",
        internalNetwork: "internal",
        dbBasis: {image: "image name", port: "port", mount: "mount name"},
        dbNote: "A guess from the image, port or mount name. It is a hint only: Portabase has not connected to any database.",
        bindNote: "Host paths come from the container's labels and mounts and are hints. The agent checks them again before any backup.",
        envNote: (n: number) => `${n} environment variable name${n === 1 ? "" : "s"} recorded (values are never stored)`,
    },
} as const;

/** Discovery warning codes → copy. Unknown codes fall back to a generic note: raw codes are never shown as the only text. */
export const WARNING_COPY: Record<string, string> = {
    "anonymous-volume-not-backed-up": "A service uses an anonymous volume. It has no stable name, so it is not covered by name.",
    "network-shared-external": "A network is shared with other stacks or created outside this stack.",
    "network-manual": "A network is not owned by this stack and no network record was visible.",
    "image-not-pinned": "A service uses an image that is not pinned to a digest.",
    "privileged-service": "A service runs privileged.",
    "bind-mount-host-path": "A bind mount uses a host path. The agent checks the path again before any backup.",
    "backup-hint-ignored": "A backup hint label had an invalid value and was ignored.",
    "compose-definition-not-read": "The compose file was not read; names and paths come from container labels only.",
    "compose-yaml-rejected": "The compose file was refused by the safety limits and was not used.",
    "container-without-service-label": "A container of this project has no service label and was skipped.",
    "mount-destination-rejected": "A mount destination was refused as unsafe and was skipped.",
    "mount-path-rejected": "A mount host path was refused as unsafe and was left out.",
    "mount-type-unsupported": "A mount of an unsupported type was skipped.",
    "label-path-rejected": "A path label was refused as unsafe and was left out.",
    "unknown-container-state": "A container reported a state this release does not know.",
};
export const WARNING_FALLBACK = "Discovery recorded a note for this stack that has no description in this release.";
export const WARNING_SEVERITY_LABELS = {info: "Note", warn: "Warning", blocker: "Blocker"} as const;

/** Service container state → label/tone (informational; never a statement about backups). */
export const SERVICE_STATE_LABELS = {
    running: {label: "Running", tone: "success"},
    exited: {label: "Exited", tone: "neutral"},
    created: {label: "Created", tone: "neutral"},
    paused: {label: "Paused", tone: "warning"},
    restarting: {label: "Restarting", tone: "warning"},
    dead: {label: "Dead", tone: "danger"},
    absent: {label: "Absent", tone: "neutral"},
} as const satisfies Record<string, {label: string; tone: Tone}>;

// ================================================================================================================
// W09 — completeness, protection state (§4.6) and the Configuration tab. All copy for these views lives here (UX-11).
// Honesty rules: discovered ≠ backed up ≠ verified ≠ restore-tested. "Protected" is only ever said for the state `protected`;
// nothing here says a backup exists unless a verified recovery point does. Rendered inline / aria-describedby, never hover-only.
// ================================================================================================================

/** Primary protection state, precedence order Failed > Partial > Stale > Kit not verified > Awaiting first backup > Protected > Unprotected. */
export const PRIMARY_STATE_LABELS = {
    failed: {label: "Failed", tone: "danger", description: "The latest backup run failed. Fix the cause shown in Activity; the last good backup, if any, is still listed below."},
    partial: {label: "Partial", tone: "warning", description: "Backups run, but something this stack needs is not covered. Full-stack recovery is not available until the gaps below are resolved."},
    stale: {label: "Stale", tone: "warning", description: "The last good backup is older than the schedule allows. Check that scheduled backups still run."},
    kit_not_verified: {label: "Recovery kit not verified", tone: "warning", description: "Backups can exist, but the recovery kit has not been generated and verified, so recovery without this dashboard is not proven."},
    awaiting_first_backup: {label: "Awaiting first backup", tone: "neutral", description: "A backup is configured but no verified recovery point exists yet. A backup that is still being verified does not count."},
    protected: {label: "Protected", tone: "success", description: "A verified recovery point exists, every required resource is covered and the recovery kit is verified."},
    unprotected: {label: "Unprotected", tone: "neutral", description: "No backup is active for this stack. Discovery alone does not back anything up."},
} as const satisfies Record<PrimaryState, {label: string; tone: Tone; description: string}>;

/** Recovery-point status wording (D43). `pending_verification` is NEVER "Protected". */
export const RP_STATUS_LABELS = {
    incomplete: {label: "Incomplete", tone: "warning", description: "Some parts of this recovery point are missing. It cannot be used for a full recovery."},
    pending_verification: {label: "Backed up · verifying", tone: "neutral", description: "The backup finished and is being verified. It does not count as protection until verification passes."},
    verified: {label: "Verified", tone: "success", description: "The backup was checked against its signed manifest."},
    failed: {label: "Failed", tone: "danger", description: "The backup or its verification failed."},
} as const satisfies Record<string, {label: string; tone: Tone; description: string}>;

export const ITEM_STATUS_LABELS = {
    captured: {label: "Captured", tone: "success", description: "A backup source covers this."},
    missing: {label: "Missing", tone: "danger", description: "Nothing backs this up yet."},
    inaccessible: {label: "Inaccessible", tone: "danger", description: "The agent cannot read this."},
    unsupported: {label: "Not supported", tone: "warning", description: "This cannot be captured as it is."},
    external: {label: "External", tone: "neutral", description: "Not owned by this stack. A backup of this stack never changes it."},
    excluded: {label: "Excluded by label", tone: "neutral", description: "A label on the container or volume asks to leave it out. Labels are defaults only."},
    accepted_exclusion: {label: "Accepted exclusion", tone: "neutral", description: "An operator accepted that this is not backed up. It is not counted as a warning."},
    unknown: {label: "Unknown", tone: "warning", description: "Portabase cannot tell yet. It is treated as not covered."},
} as const satisfies Record<ItemStatus, {label: string; tone: Tone; description: string}>;

export const ITEM_KIND_LABELS = {
    compose_file: "Compose file", env_file: "Environment file", bind: "Bind mount", volume: "Named volume", anonymous_volume: "Anonymous volume",
    database: "Database", image: "Image", network: "Network", dependency: "Dependency",
    member_source: "Backup source", agent: "Agent", policy: "Backup policy",
} as const satisfies Record<ItemKind, string>;

/** One sentence per reason: what is true and what to do. Shown inline next to the item. */
export const REASON_COPY = {
    captured: "A backup source covers this and it was checked.",
    captured_manual: "Covered by a source you added by hand.",
    db_file_copy_only: "This database is saved only by copying its files while it runs. That can be inconsistent, so the stack stays Partial until a database dump covers it.",
    not_covered: "No backup source covers this yet.",
    compose_location_unknown: "The location of the compose file is not known. Add it as a manual source.",
    file_absent: "The agent looked for this file and it is not there.",
    unreadable: "The agent cannot read this path. Fix the permissions on the host or add a readable copy as a manual source.",
    probe_pending: "A source covers this, but the agent has not confirmed it can read it yet.",
    env_files_undetermined: "The compose file was not read, so Portabase cannot tell which environment files this stack needs.",
    env_implicit_unknown: "A .env file next to the compose file is only known by looking on the host, which has not happened yet.",
    denied_path: "This path is refused: it is the root of the filesystem, not absolute, or contains unsafe parts.",
    outside_allowed_roots: "This path is outside the folders the environment allows backups from.",
    volume_driver: "This volume uses a driver Portabase cannot read by name.",
    image_local: "This image was built on the host and is not published. Rebuild it from its source on a new host, or keep an archive of it.",
    anonymous_volume: "An anonymous volume has no stable name, so it is not covered by name. Name it in the compose file, or accept the exclusion.",
    external_volume: "This volume is shared with other stacks or created outside this stack. Its data is not part of this stack's backup.",
    external_network: "This network is shared with other stacks or created outside this stack. A restore never changes it; it must exist on the target.",
    external_dependency: "This service runs outside the stack. Its data is not backed up here.",
    excluded_by_label: "Left out because of a backup label.",
    accepted: "Accepted by an operator.",
    // W10: findings about the stack's own sources / agent / policy.
    agent_poll_failing: "Agent poll failing: the agent has stopped reporting since these sources were added. One source the agent cannot reach, for example a Docker volume without Docker socket access, stops every backup on that agent. Check the agent first; Portabase cannot tell this apart from an agent that is simply down.",
    agent_unavailable: "The agent that should back up this stack is not mapped, archived or not allowed for this environment. Fix the environment settings.",
    source_drifted: "A backup source was changed or removed outside this stack's configuration. It is not trusted until you apply the stack configuration again.",
    encryption_off: "Backup encryption is switched off for this instance. A stack backup contains compose files and secrets, so it must not run unencrypted. Turn encryption on in the instance settings.",
    inventory_changed: "The stack changed on the host since its backup sources were set up. Apply the stack configuration again so new resources are covered.",
} as const satisfies Record<ReasonCode, string>;

export const DIRECTIVE_COPY = {
    privileged: "Runs privileged. A restore refuses this unless you confirm it for this service.",
    host_network: "Uses the host network. A restore refuses this unless you confirm it for this service.",
    shared_netns: "Shares another container's network. A restore refuses this unless you confirm it for this service.",
    docker_socket: "Mounts the Docker socket, which gives full control of Docker on this machine. A restore refuses this unless you confirm it for this service.",
    system_path: "Mounts a system path of the host. It is not backed up by design.",
} as const satisfies Record<DirectiveCode, string>;

export const FACET_COPY = {
    heading: "Backup facts",
    lastGood: {
        label: "Last good backup",
        never: "No verified backup yet",
        ago: (h: number) => (h < 1 ? "less than an hour ago" : h < 48 ? `${Math.floor(h)} h ago` : `${Math.floor(h / 24)} d ago`),
        verifying: "A newer backup is being verified (Backed up · verifying). It counts once verification passes.",
        description: "Only verified recovery points count.",
    },
    testRestore: {label: "Data verified by test restore", never: "Not tested", ago: (d: number) => `${Math.floor(d)} d ago`, stale: "Out of date", staleDescription: (n: number) => `No successful test restore in the last ${n} days.`,
        /** Value text of the facet: "N d ago", plus the decay marker once it is out of date (W-TR). */
        value: (d: number | null, stale: boolean) => (d === null ? "Not tested" : `${Math.floor(d)} d ago${stale ? " · Out of date" : ""}`),
        description: "Proved by restoring the data on a test host, checking it, and wiping it. The app was not started."},
    deletable: {
        label: "Deletable from source host",
        values: {yes: "Yes", no: "No", not_checked: "Not checked"} as const satisfies Record<Deletable, string>,
        description: {
            yes: "Someone with access to the source host can delete the backup copy.",
            no: "The backup copy cannot be deleted with the source host's credentials.",
            not_checked: "Nobody has checked whether the source host can delete the copy. Treated as yes.",
        } as const satisfies Record<Deletable, string>,
    },
    hostCompromise: {label: "Not protected against host compromise", description: "If the source host is taken over, the backup copies may be deleted too. This needs attention but does not make the stack Partial."},
    consistency: {
        label: "Consistency",
        values: {database_saved_safely: "Database saved safely", files_copied_running: "Files copied while running", app_paused: "App paused during copy"} as const satisfies Record<ConsistencyFacet, string>,
        none: "No member is covered yet.",
    },
    paused: {label: "Paused", description: "The backup is paused. The user who activated it no longer has the rights to run it; an administrator must re-authorise it."},
    inventoryStale: {label: "Inventory stale", description: "Arcane could not be reached. Backups use the last known inventory."},
    configLocked: {label: "Fork configuration locked", description: "Stack Recovery configuration is locked because this instance is not single-organization. Scheduled backups are not affected."},
    needsAttention: "Needs attention",
    yes: "Yes",
} as const;

export const BLOCKERS_PANEL = {
    heading: "Backup blockers",
    none: "No blockers: every required resource is covered or accounted for.",
    noneNotComplete: "No blockers, but some items are not confirmed yet. See the Configuration tab.",
    unavailable: "Full-stack recovery is not available until resolved.",
    summary: (blockers: number, gaps: number) => `${blockers} blocker${blockers === 1 ? "" : "s"}, ${gaps} item${gaps === 1 ? "" : "s"} not covered in total.`,
    more: (n: number) => `${n} more on the Configuration tab.`,
    viewAll: "Open Configuration",
    unreadable: "Blockers cannot be shown because the inventory could not be read.",
} as const;

/** Managed backup sources (W10, D30 "Managed by stack X"). Copy for every source status / drift reason / probe; closed vocabularies, labels coverage test enforces them. */
export const SOURCES_COPY = {
    heading: "Backup sources managed by this stack",
    caption: "Backup sources created and managed for this stack, with status and last agent check",
    note: "Portabase created these as ordinary sources in a project managed by this stack. Do not give them a schedule or retention of their own: that is reset automatically, because the stack schedule controls them.",
    none: "No backup sources have been created for this stack yet.",
    columns: {name: "Source", role: "Covers", status: "Status", probe: "Agent check"},
    role: {compose: "Compose files", env: "Environment files", bind: "Folder on the host", volume: "Docker volume", db: "Database"},
    origin: {discovered: "", manual: " (added by hand)"},
    status: {
        planned: {label: "Waiting", tone: "warning", description: "Not created yet: Portabase first needs proof that the agent can use Docker."},
        canary: {label: "Checking", tone: "warning", description: "Created first to prove the agent can use Docker. It is removed again if the agent stops reporting."},
        active: {label: "Active", tone: "success", description: "A normal backup source on the agent."},
        drifted: {label: "Changed outside", tone: "danger", description: "Changed or removed outside this stack's configuration. It is not trusted until the configuration is applied again."},
        orphaned: {label: "No longer needed", tone: "neutral", description: "The stack no longer has this resource. Nothing was deleted; remove it when you are sure."},
        blocked: {label: "Blocked", tone: "danger", description: "Removed again because the agent stopped reporting right after it was added."},
    },
    probe: {readable: "Agent can read it", unreadable: "Agent cannot read it", none: "Not checked yet"},
    reason: {
        source_removed: "The source was deleted or detached.",
        source_moved: "The source was moved to another project.",
        agent_changed: "The source was moved to another agent.",
        type_changed: "The source type was changed.",
        method_changed: "The backup method was changed.",
        unsafe_volume: "The volume name is not allowed (it must be a plain Docker volume name) or a container is attached.",
        config_changed: "The path or volume of the source was changed.",
        channel_changed: "The source got a storage channel of its own.",
        not_in_plan: "The stack no longer has this resource.",
        agent_poll_failing: "The agent stopped reporting after this source was added.",
    },
} as const satisfies {
    heading: string; caption: string; note: string; none: string; columns: Record<string, string>; role: Record<SourceView["role"], string>; origin: Record<SourceView["origin"], string>;
    status: Record<SourceView["status"], {label: string; tone: Tone; description: string}>; probe: Record<NonNullable<SourceView["probe"]> | "none", string>; reason: Record<NonNullable<SourceView["reason"]>, string>;
};

export const CONFIG_TAB = {
    tab: "Configuration",
    intro: "What a full recovery of this stack needs, and whether each part is covered. Names, paths and hashes only: file contents and variable values are never shown and never stored here.",
    checklist: {heading: "Coverage checklist", caption: "Required resources and their coverage", columns: {resource: "Resource", kind: "Type", status: "Status", why: "Why"}, none: "No required resources were found.", summary: (done: number, total: number) => `${done} of ${total} covered or accounted for`},
    files: {
        heading: "Compose and environment files",
        caption: "Compose and environment files with placement, status and hash",
        columns: {file: "File", placement: "Placement", status: "Status", hash: "Hash"},
        placement: {here: "Managed here", outside: "Referenced from outside"},
        placementNote: "Managed here means the file sits inside the stack's working directory. Referenced from outside means it lives elsewhere on the host.",
        hashNone: "Not captured yet",
        none: "No compose or environment files are known for this stack.",
    },
    env: {
        heading: "Environment variable names",
        caption: "Environment variable names per service; values hidden",
        masked: "Hidden: values are never read or stored",
        note: "Only the names Arcane reported from the compose file. Values stay on the host.",
        undetermined: "The compose file was not read, so variable names are not known.",
        none: "No environment variables are declared.",
        more: (n: number) => `${n} more name${n === 1 ? "" : "s"} not shown`,
        columns: {service: "Service", names: "Variable", value: "Value"},
    },
    directives: {heading: "Restore safety notes", note: "Informational. These never block a backup; a restore asks you to confirm each one.", none: "No privileged, host-network or Docker-socket settings were found."},
    networks: {heading: "Networks", caption: "Networks with owner and subnets", columns: {network: "Network", ownership: "Owner", subnets: "Subnets"}, ownership: {stack_owned: "This stack", shared_external: "Shared (external)", manual: "Not owned, no record"}, noSubnets: "Default"},
    hash: {heading: "Inventory", label: "Inventory hash", note: "Fingerprint of the discovered inventory shown here. File hashes appear once files are captured."},
    resolve: {
        addSource: "Add manual source",
        addSourceReason: "Adding a source by hand arrives with backup configuration, which is not built yet.",
        accept: "Accept exclusion",
        acceptReason: "Accepting a gap arrives with backup configuration, which is not built yet.",
        help: "Missing compose files, environment files and unreadable paths can be resolved by adding a source by hand. Other items need a change in the stack itself or an accepted exclusion.",
    },
    readOnly: "This tab is read-only. There is no download of file contents.",
} as const;

/** W11 — Configure backup (single page). Every sentence of the form lives here; component code carries none (rendered as inline text / aria-describedby, never hover-only). */
export const CONFIGURE = {
    title: "Configure backup",
    intro: "Choose what to back up, how, when and where. Nothing is saved until you press Activate; leaving this page discards your choices.",
    back: "Back to stack",
    requiredNote: "Fields marked * are required.",
    nonAdmin: {title: "Only a system administrator configures backups", body: "You can see this stack, but its backup configuration is changed by a system administrator."},
    noInventory: {title: "Nothing to configure yet", body: "This stack has no readable inventory. Run a sync from Integrations first."},
    locked: "Fork configuration is locked, so a backup policy cannot be activated right now. Fix the cause in the status banner first.",
    sections: {resources: "Resources", consistency: "Consistency", schedule: "Schedule", storage: "Storage", review: "Review & activate"},
    resources: {
        intro: "What this stack needs to be recovered. Untick something to leave it out; leaving out a required resource means the stack cannot be recovered completely.",
        columns: {name: "Resource", role: "Role", plan: "In this backup"},
        listLabel: "Resources of this stack",
        roleRequired: "Required",
        roleOptional: "Optional",
        include: (name: string) => `Include ${name} in the backup`,
        composeDir: "Compose folder (compose files and environment files)",
        plan: {
            backed_up: "Included",
            not_backed_up: "Not included",
            external: "Outside this stack",
            excluded: "Left out by a label",
            accepted: "Accepted gap",
        },
        fromLabel: "from label",
        fromLabelNote: "A label on the container or volume asks to leave this out. Your choice here wins.",
        notRecoverable: "Not recoverable without it: the stack stays Partial until this is covered or you accept the gap.",
        accept: (name: string) => `I accept that ${name} is not recovered`,
        none: "No resources were found for this stack.",
        manual: {
            heading: "Add a path or source",
            intro: "Discovery cannot see everything. Add a folder or file on the host the agent can read; it counts toward completeness like a discovered one.",
            path: "Path on the host",
            covers: "It covers",
            coversNone: "Nothing needs a manual source right now",
            add: "Add path",
            remove: (p: string) => `Remove ${p}`,
            addedByYou: "added by you",
            noRoots: "No allowed path roots are configured for this environment, so manual paths cannot be checked. Set them on the Integrations page first.",
        },
        volume: {
            heading: "Add a Docker volume by name",
            intro: "Only a plain volume name that exists in this stack is accepted. Paths are never accepted.",
            name: "Volume name",
            add: "Add volume",
            added: (n: string) => `Volume ${n} is part of the backup.`,
            already: "This volume is already part of the backup.",
        },
    },
    consistency: {
        intro: "Databases saved as files while they run can be unusable on restore. A database dump is consistent; copied files are only crash-consistent.",
        none: "No database was recognised in this stack.",
        dump: "Database dump (consistent)",
        files: "Files copied while running (crash-consistent)",
        filesWarning: "A database copied as files while it runs can be unusable after a restore. The stack stays Partial.",
        unsupported: (engine: string) => `Portabase cannot dump ${engine} in this release. Its files are copied while it runs; the stack stays Partial.`,
        sqlite: "SQLite database file",
        sqlitePath: "Path of the database file as the agent sees it",
        fields: {host: "Host the agent connects to", port: "Port", username: "User", database: "Database", password: "Password"},
        hostHint: "A network name the agent can resolve for this database. localhost does not work: the agent runs elsewhere.",
        passwordStored: "The password is encrypted on the server and never shown again.",
        stopLabel: "A label asks to pause the app during backup. That is not available until release R2; files are copied while running.",
        stopFor: (services: string) => `Affected: ${services}.`,
        labelHint: "from label",
        noStopControl: "",
    },
    schedule: {
        intro: "When the whole stack is backed up together. Times follow the timezone you choose.",
        preset: "How often",
        presets: {hourly: "Every hour", every_6h: "Every 6 hours", every_12h: "Every 12 hours", daily: "Every day", weekly: "Every week", monthly: "Every month", cron: "Custom (cron)"},
        minute: "At minute",
        time: "At time",
        weekday: "On",
        weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        monthday: "On day of month (1–28)",
        timezone: "Timezone",
        advanced: "Advanced: custom cron expression",
        advancedHint: "Five fields: minute hour day-of-month month day-of-week. Presets are enough for most stacks.",
        cron: "Cron expression",
        cronInvalid: "This is not a valid five-field cron expression.",
        cronClear: "Use a preset instead",
        next: "Next three runs",
        nextUtc: "UTC",
        retention: {
            heading: "How long backups are kept",
            intro: "Recovery points are thinned by age: the newest are kept, then one per day, week, month and year. Only verified recovery points count.",
            keep_last: "Keep the newest",
            daily: "Then one per day for",
            weekly: "One per week for",
            monthly: "One per month for",
            yearly: "One per year for",
            unit: {keep_last: "recovery points", daily: "days", weekly: "weeks", monthly: "months", yearly: "years"},
        },
    },
    storage: {
        intro: "Where recovery points are written. At least one channel must be off the dashboard host: backups kept only next to the dashboard are lost together with it.",
        listLabel: "Storage channels",
        none: "No storage channel is available to this organization. Add one under Storages first.",
        local: "Lives on the dashboard host",
        deletable: {
            label: "Deletable from source host",
            yes: "yes",
            no: "no",
            not_checked: "not checked",
        },
        deletableNote: "Not checked means nothing has proven that a compromised source host cannot delete these backups, so this stack will show Not protected against host compromise.",
        rule: {
            no_channel_selected: "Select at least one storage channel.",
            local_only_channels: "Local storage lives on the dashboard host and is lost with it; add an off-host channel.",
        },
        size: {
            heading: "Steady-state size estimate",
            known: (human: string, counted: number) => `About ${human} for one full copy of ${counted} volume${counted === 1 ? "" : "s"}, from the sizes Arcane reported, before compression and deduplication.`,
            unknownSome: (n: number) => `${n} source${n === 1 ? "" : "s"} did not report a size and are not counted.`,
            unknown: "Not known until the first backup: Arcane did not report sizes for these resources.",
        },
        encryptionOff: "Encryption is off in the instance settings. A backup policy cannot be activated until it is turned on, because unencrypted backups can never be verified.",
    },
    review: {
        intro: "What this configuration does. Nothing below is saved until you activate.",
        summaryLabel: "Summary",
        included: (n: number) => `${n} resource${n === 1 ? "" : "s"} included in the backup`,
        gaps: (n: number) => `${n} required resource${n === 1 ? "" : "s"} not covered. The stack will show Partial.`,
        complete: "Every required resource is covered by this plan. Whether the agent can read each path is checked after activation.",
        readability: "Protection reads Protected only after a verified recovery point exists and the recovery kit is verified; this page cannot promise that.",
        sources: "Backup sources that will be created",
        sourcesNone: "No backup source would be created with these choices.",
        skipped: "Skipped",
        blockersHeading: "Before you can activate",
        dockerConfirm: "I confirm the Portabase agent for this stack can use the Docker socket. Without it, Docker volumes are prepared but not backed up.",
        dockerNote: "Portabase cannot test this from the dashboard. One volume is created first as a check and removed again if the agent stops reporting.",
        activate: "Activate backup",
        activating: "Activating…",
        runFirst: "Run first backup",
        edit: "Update the active policy",
        activeNote: "This stack already has an active policy. Activating again updates it.",
        secretNeeded: (s: string) => `Enter the database password for ${s}.`,
        dbIncomplete: (s: string) => `Complete the connection details for the ${s} database, or choose files copied while running.`,
        blockers: {
            locked: "Fork configuration is locked.",
            encryption_off: "Turn encryption on in the instance settings first.",
            no_channel_selected: "Select a storage channel.",
            local_only_channels: "Add an off-host storage channel; local storage alone is not enough.",
            invalid_schedule: "Fix the schedule.",
            invalid_retention: "Fix the retention values.",
            selection_issues: "Fix the highlighted fields.",
        },
        success: {
            title: "Backup policy activated",
            body: (sources: number, runs: string) => `${sources} backup source${sources === 1 ? "" : "s"} are set up. Next scheduled run: ${runs}.`,
            deferred: (n: number) => `${n} Docker volume${n === 1 ? " is" : "s are"} not backed up yet: they wait for the agent check.`,
            skipped: (n: number) => `${n} resource${n === 1 ? " was" : "s were"} not given a backup source:`,
            skipReason: {
                excluded_hint: "left out by a label",
                excluded_selection: "left out by you",
                external_volume: "shared with other stacks, not owned by this one",
                unsupported_driver: "its volume driver cannot be read by the agent",
                anonymous_volume: "anonymous volume: it has no stable name to back up",
                volume_name_invalid: "not a plain volume name",
                volume_not_in_inventory: "not found in this stack",
                bind_path_denied: "a protected or disallowed path",
                compose_location_unknown: "the compose folder is not known",
                db_not_selected: "no database dump chosen (its files are copied while it runs)",
                db_input_invalid: "database details are missing or not allowed",
                tmpfs: "memory-only mount, nothing to keep",
                manual_invalid: "the path is not allowed",
                manual_key_unknown: "it does not cover a known resource",
            } as Record<string, string>,
            view: "View the stack",
        },
        failure: {
            title: "Not activated",
            forbidden: "Only a system administrator can activate a backup policy.",
            not_found: "This stack no longer exists. Reload the page.",
            locked: "Fork configuration is locked, so nothing was changed.",
            rate_limited: "Too many attempts. Wait a moment and try again.",
            invalid_input: "Check the values you entered.",
            encryption_required: "Encryption must be enabled in the instance settings first.",
            no_channel_selected: "Select at least one storage channel.",
            local_only_channels: "Local storage lives on the dashboard host and is lost with it; add an off-host channel.",
            channels_unavailable: "A selected storage channel is not available to this organization.",
            selection_invalid: "Some of the entered resources cannot be backed up as entered. See the highlighted fields.",
            secret_required: "A database password is required.",
            method_change: "The backup method of an existing source cannot be changed. Remove the source first (only possible before its first backup).",
            agent_unavailable: "The agent for this stack is not available or you are not allowed to manage it.",
            agent_version: "The agent is too old for stack backups.",
            no_agent: "This environment is not mapped to a Portabase agent.",
            environment_disabled: "This environment is not enabled.",
            project_name_taken: "A project with this name already exists and is not managed by this stack.",
            no_inventory: "No usable inventory for this stack yet. Run a sync first.",
            stack_gone: "This stack is no longer on the host.",
            activation_failed: "The backup sources were prepared, but the policy could not be activated. Nothing is scheduled. Try again.",
            refused: "The server refused the request. Nothing was activated.",
        } as Record<string, string>,
        transport: "The request failed before the server answered, so nothing is known to have changed. Reload the page to see the current state.",
    },
    fieldErrors: {
        volume_name_path_like: "This is not a volume name. Volume names are plain names like app_data, never a path.",
        volume_name_anonymous: "This looks like an anonymous volume (a random id). Only named volumes can be backed up.",
        volume_not_in_inventory: "No volume with this name exists in this stack.",
        key_unknown: "This resource is not part of this stack.",
        manual_invalid: "The agent cannot back up this path: it is outside the allowed roots or a protected system path.",
        manual_roots_missing: "No allowed path roots are configured for this environment.",
        manual_key_unknown: "It must cover a resource that needs a manual source.",
        db_input_invalid: "Some database connection fields are missing or not allowed (localhost is not accepted).",
        db_service_unknown: "This service is not a recognised database.",
    } as Record<string, string>,
} as const;

/** W11 — the Schedule tab of the stack details (placeholder until W13 builds the real tab). */
export const SCHEDULE_TAB = {
    tab: "Schedule",
    heading: "Backup schedule",
    none: {title: "No backup policy yet", body: "This stack is not backed up on a schedule. Configure a backup to choose what, when and where."},
    configure: "Configure backup",
    rows: {
        activated: "Activated", schedule: "Schedule", timezone: "Timezone", next: "Next runs", retention: "Kept", channels: "Storage", sources: "Backup sources", consistency: "Consistency",
    },
    consistency: {crash: "Files copied while running", dump: "Database dump plus files", stop: "App paused during copy"},
    retention: (r: {keep_last: number; daily: number; weekly: number; monthly: number; yearly: number}) =>
        `newest ${r.keep_last}, then ${r.daily} daily, ${r.weekly} weekly, ${r.monthly} monthly, ${r.yearly} yearly`,
    local: "lives on the dashboard host",
    note: "Times are shown in the schedule's timezone. Run history is in the Activity tab, recovery points in the Backups tab.",
} as const;

/** W12: runs, plain words. Nothing here promises more than the data says: a finished backup is "backed up, verifying", never "verified" (D43). */
export const RUNS = {
    heading: "Latest run",
    none: "No backup has run yet.",
    when: {manual: "Started by an administrator", schedule: "Started by the schedule"},
    states: {
        starting: "Starting", running: "Running", finalizing: "Finishing", succeeded: "Backed up · verifying", incomplete: "Finished, but incomplete",
        failed: "Failed", cancelled: "Cancelled", skipped: "Skipped",
    },
    skip: {overlap: "Skipped: the previous run was still going.", missed: "Skipped: the run could not start in time."},
    reasons: {
        agent_did_not_start: (n: number) => `Agent did not start the backup within ${n} min`,
        agent_made_no_progress: (n: number) => `The agent started the backup but made no progress within ${n} min`,
        run_timeout: () => "The run took longer than the maximum allowed time",
        member_failed: () => "At least one part of the stack could not be backed up",
        member_busy: () => "A backup of one part was already waiting or running",
        member_method_conflict: () => "One part has a backup method conflict",
        member_not_active: () => "One part of the stack was not ready to be backed up",
        member_vanished: () => "One backup source no longer exists",
        storage_failed: () => "A storage channel did not accept the backup",
        nothing_queued: () => "No part of the stack could be started",
        cancelled: () => "The run was cancelled",
        interrupted: () => "The run was interrupted",
        capacity: () => "Too many backups are running on this host; try again shortly",
        internal_error: () => "The run stopped because of an internal error",
    },
    rp: {label: "Recovery point"},
    blocked: "Some required resources were not covered, so this recovery point is incomplete.",
    refresh: {
        failed: "Arcane could not be reached, so this run used the last known inventory.",
        skipped_locked: "Fork configuration is locked, so the inventory was not refreshed for this run.",
    },
    paused: {
        title: "Backups are paused",
        reasons: {
            user_missing: "The administrator who activated this backup no longer exists.",
            user_blocked: "The administrator who activated this backup can no longer sign in.",
            capability_lost: "The administrator who activated this backup is no longer a system administrator.",
            agent_acl_lost: "The administrator who activated this backup no longer manages the agent.",
            encryption_off: "Backup encryption was turned off.",
            channels_unavailable: "A storage channel is no longer available.",
            agent_gone: "The Portabase agent for this stack no longer exists.",
        },
        fix: "No backup runs until a system administrator opens Configure backup and activates the policy again.",
    },
    action: {
        run: "Back up now",
        running: "Starting…",
        reasons: {
            no_policy: "Configure and activate a backup policy first.",
            paused: "Backups are paused. Activate the policy again to resume.",
            active: "A backup is already running.",
            member: "Only an organization administrator can start a backup.",
        },
        outcome: {
            started: "Backup started. Progress shows here; it can take a few minutes.",
            already_running: "A backup is already running for this stack.",
            capacity: "Too many backups are running on this host. Try again in a few minutes.",
            paused: "Backups are paused for this stack.",
            reauth_failed: "The backup could not start because the policy's authorization no longer holds. The policy is now paused.",
            not_active: "This stack has no active backup policy.",
            not_found: "Stack not found.",
            forbidden: "Only an organization administrator can start a backup.",
            rate_limited: "Too many attempts. Wait a moment and try again.",
            off: "Stack Recovery is not enabled.",
            invalid_input: "That request was not valid.",
        },
        cancel: "Cancel run",
        cancelled: "The run was cancelled.",
    },
} as const;

// ================================================================================================================
// W13 — notification bodies (§4.7). FIXED sentences keyed by closed codes: a notification body is built from these + the sanitised stack
// name + a link, and from nothing else (no path, key name, raw error, environment value). Unknown codes fall back to the generic sentence.
// ================================================================================================================
export const NOTIFY = {
    titlePrefix: "Portabase",
    generic: "Open the dashboard for details.",
    stackFallback: "A stack",
    kinds: {
        "restore.finished": {title: "Restore finished", sentence: "A restore finished and its services started."},
        "restore.failed": {title: "Restore did not finish", sentence: "A restore stopped before it was complete. Open the stack to see which step failed."},
        "test_restore.failed": {title: "Test restore failed", sentence: "A test restore failed."},
        "test_restore.wipe_failed": {title: "Test restore copy not wiped", sentence: "The test-restore copy on the test host could not be wiped. Wipe it now."},
        "test_restore.skipped": {title: "Test restore did not run", sentence: "A scheduled test restore did not run."},
        "stack.test_restore_stale": {title: "No recent test restore", sentence: "No recent successful test restore."},
        "restore.needs_approval": {title: "Restore waiting for approval", sentence: "A restore is waiting for an owner to approve flagged settings."},
        "run.failed": {title: "Backup failed", sentence: "The backup failed."},
        "run.blocked": {title: "Backup incomplete", sentence: "The backup is incomplete: some required resources are not covered."},
        "run.incomplete": {title: "Backup incomplete", sentence: "The backup finished but is incomplete."},
        "run.skipped": {title: "Scheduled backup skipped", sentence: "A scheduled backup did not run."},
        "run.policy_paused": {title: "Backups paused", sentence: "Scheduled backups are paused until an administrator re-authorises them."},
        "stack.partial": {title: "Backup no longer covers everything", sentence: "This stack is now only partly covered by its backup."},
        "stack.no_good_backup": {title: "No good backup", sentence: "There has been no verified backup for this stack for a long time."},
        "kit.unverified": {title: "Recovery kit not verified", sentence: "The recovery kit needs to be verified."},
        "kit.key_rotated": {title: "Recovery kit needs re-verification", sentence: "The backup key was rotated; verify the recovery kit again."},
        "fork.selfcheck.failed": {title: "Fork configuration locked", sentence: "Stack Recovery configuration is locked. Scheduled backups keep running."},
        "fork.selfcheck.recovered": {title: "Fork configuration unlocked", sentence: "Stack Recovery configuration is open again."},
        "quiesce.failed": {title: "App could not be paused or restarted safely", sentence: "A backup could not pause or restart the app safely."},
        "stack.quiesce_stopped": {title: "Containers are stopped", sentence: "A backup stopped containers of this stack and they are not running again yet."},
    },
    /** Short reason phrases keyed by the closed recovery-point / skip / pause codes. */
    reasons: {
        validator_blocked: "Some required resources are not covered.",
        member_failed: "At least one part of the stack could not be backed up.",
        member_timeout: "An agent did not start or finish a backup in time.",
        unencrypted: "A backup was not encrypted.",
        checksum_unavailable: "A backup checksum could not be computed.",
        run_cancelled: "The run was cancelled.",
        run_not_started: "No part of the stack could be started.",
        run_error: "The run stopped because of an internal error.",
        artifact_missing: "A backup file is missing.",
        count_mismatch: "A backup file is missing.",
        fk_null: "A backup file is missing.",
        overlap: "The previous run was still going.",
        missed: "The run could not start in time.",
        user_missing: "The administrator who activated the backup no longer exists.",
        user_blocked: "The administrator who activated the backup can no longer sign in.",
        capability_lost: "The administrator who activated the backup is no longer a system administrator.",
        agent_acl_lost: "The administrator who activated the backup no longer manages the agent.",
        encryption_off: "Backup encryption was turned off.",
        channels_unavailable: "A storage channel is no longer available.",
        agent_gone: "The Portabase agent for this stack no longer exists.",
    } as Record<string, string>,
    noGoodBackupHours: (h: number) => `No verified backup for ${h} h.`,
    noChannelNote: {title: "Alerts are not delivered", body: "No notification channel is set as the default in the instance settings, so backup alerts are recorded but not sent."},
} as const;

// ================================================================================================================
// W13 — Backups / Activity tabs, the "Am I safe?" strip and the schedule editor. Honest by construction: a recovery point that is only
// "Backed up · verifying" is never called verified or protected; verification, restore and mirrors are visibly not available yet.
// ================================================================================================================
export const BACKUPS = {
    tab: "Backups",
    heading: "Recovery points",
    none: {title: "No recovery points yet", body: "A recovery point is created when a backup run finishes. Start one with Back up now, or wait for the schedule."},
    count: (shown: number, total: number) => (shown < total ? `Showing the newest ${shown} of ${total} recovery points.` : `${total} recovery point${total === 1 ? "" : "s"}.`),
    runNow: "Back up now",
    verify: {label: "Verify", reason: "Verification arrives with the verify job in a later step of this release. Until then a finished backup stays \"Backed up · verifying\"."},
    restore: {label: "Restore", reason: "Restoring from the dashboard is planned for release R2."},
    mirror: {label: "Create test mirror", reason: "Test mirrors are not part of this release."},
    columns: {id: "Recovery point", time: "Created", consistency: "Consistency", destinations: "Stored in", size: "Size", duration: "Took", verification: "Verification", status: "Status"},
    consistency: {
        crash_consistent_files: "Files copied while running", engine_dump: "Database saved safely", mixed: "Database dump plus files copied while running", unknown: "Not recorded", stopped: "App paused during copy",
    } as const,
    verification: {
        verified: (when: string) => `Verified ${when}`,
        pending_verification: "Not verified yet — waiting for the verify job",
        incomplete: "Not verifiable: incomplete",
        failed: "Not verified: the backup failed",
    },
    reasons: {
        fk_null: "A backup file is no longer linked.", artifact_missing: "A backup file is missing.", count_mismatch: "Fewer backup files exist than were required.",
        retention_partial: "Cleaning up old backups did not finish; some files remain.", stack_removed: "The stack was removed.", verify_failed: "Verification failed.",
        plaintext_hash_mismatch: "The verification checksum did not match.", validator_blocked: "Some required resources were not covered.",
        member_failed: "At least one part of the stack could not be backed up.", member_timeout: "An agent did not start or finish a backup in time.",
        unencrypted: "A backup file is not encrypted.", checksum_unavailable: "A backup checksum could not be computed.", run_cancelled: "The run was cancelled.",
        run_not_started: "No part of the stack could be started.", run_error: "The run stopped because of an internal error.",
        quiesce_unconfirmed: "The app was paused for the copy, but it was never confirmed that it started again.",
    } as const,
    trigger: {manual: "Started by an administrator", schedule: "Started by the schedule"},
    detail: {
        heading: (n: number) => `Recovery point #${n}`,
        close: "Close details",
        open: "Show details",
        coverage: "Coverage",
        coverageValue: (present: number, required: number) => `${present} of ${required} required backup file${required === 1 ? "" : "s"} present`,
        inventory: "Inventory version",
        warnings: "Warnings",
        noWarnings: "No warnings.",
        artifacts: "Backup files",
        noArtifacts: "No backup file was recorded for this recovery point.",
        artifactColumns: {source: "Source", kind: "Kind", stored: "Stored in", size: "Size", encrypted: "Encrypted", checksum: "Checksum", presence: "Present"},
        kind: {archive_enc: "Encrypted archive", archive_plain: "Plain archive", restic_snapshot: "Repository snapshot"} as const,
        presence: {present: "Yes", missing: "Missing", unknown: "Not confirmed"} as const,
        yes: "Yes", no: "No",
        checksumNone: "Not recorded (a repository snapshot is identified by its snapshot id)",
        integrity: "Integrity checks",
        integrityRows: {
            encrypted: (all: boolean) => (all ? "Every backup file is encrypted." : "At least one backup file is not encrypted."),
            checksum: (n: number, of: number) => `${n} of ${of} archive file${of === 1 ? "" : "s"} have a recorded checksum.`,
            presence: (n: number, of: number) => `${n} of ${of} backup file${of === 1 ? "" : "s"} confirmed present.`,
            signature: "Signed manifest and restore verification: not available yet (arrives with the verify job).",
        },
        removedChannel: "Removed storage channel",
    },
} as const;

export const ACTIVITY = {
    tab: "Activity",
    heading: "Backup activity",
    none: {title: "No backup activity yet", body: "Runs appear here with their stages once the first backup starts."},
    count: (shown: number, total: number) => (shown < total ? `Showing the newest ${shown} of ${total} runs.` : `${total} run${total === 1 ? "" : "s"}.`),
    runLabel: "Reference",
    reference: "Quote this reference when asking for help",
    stagesHeading: "Stages",
    itemsHeading: "Parts of the stack",
    noItems: "No part of the stack was started in this run.",
    stage: {
        refresh_inventory: "Discover: refresh the stack inventory", validate: "Validate: check what is covered", trigger: "Start the member backups",
        track: "Database dump, file copy and upload (run by the agent)",
        quiesce_stop: "Pause the app: stop the selected containers (run by the agent)", trigger_window: "Start the file and volume copies while the app is paused",
        track_window: "File and volume copy and upload (run by the agent)", quiesce_release: "Start the app again and check it is running",
        hash: "Checksums of the stored files", finalize: "Commit the recovery point",
    } as const,
    verifyStage: "Verify: not available yet (arrives with the verify job)",
    stepStatus: {pending: "Waiting", running: "In progress", done: "Done", failed: "Failed"} as const,
    attempts: (n: number) => `checked ${n} time${n === 1 ? "" : "s"}`,
    itemState: {queued: "Queued", running: "In progress", succeeded: "Backed up", failed: "Failed", skipped: "Skipped"} as const,
    required: "required",
    optional: "optional",
    dbms: {files: "Files", "docker-volume": "Docker volume"} as Record<string, string>,
    dbmsFallback: "Database dump",
    started: "Started",
    finished: "Finished",
    announce: (stage: string) => `Backup stage: ${stage}`,
    rp: (seq: number) => `Recovery point #${seq}`,
    openBackups: "Open in Backups",
} as const;

export const STRIP = {
    heading: "Am I safe?",
    intro: "One line per stack. Only a stack with a verified recovery point and a verified recovery kit can be Safe.",
    buckets: {
        safe: {label: "Safe", tone: "success", empty: "No stack is Safe yet."},
        needs_attention: {label: "Needs attention", tone: "warning", empty: "Nothing needs attention."},
        not_protected: {label: "Not protected", tone: "neutral", empty: "Every stack has a backup configured."},
    } as const,
    reasons: {
        failed: {label: "Latest backup failed", fix: "Open Activity"},
        partial: {label: "Part of the stack is not covered", fix: "See what is missing"},
        stale: {label: "Last good backup is too old", fix: "Open Activity"},
        kit_not_verified: {label: "Recovery kit not verified", fix: "Open Backups"},
        host_compromise: {label: "Backups may be deletable from the source host", fix: "Review storage"},
        paused: {label: "Backups are paused", fix: "Re-authorise the backup"},
        inventory_stale: {label: "Stack list is out of date (Arcane unreachable)", fix: "Open Integrations"},
        config_locked: {label: "Configuration is locked", fix: "Open the stack"},
        agent_poll_failing: {label: "The agent is not answering", fix: "Open Agents"},
        unprotected: {label: "No backup configured", fix: "Configure backup"},
        awaiting_first_backup: {label: "Waiting for the first verified backup", fix: "Configure backup"},
        no_inventory: {label: "No readable inventory yet", fix: "Open the stack"},
    } as const,
    agentIssue: (agent: string) => `Agent poll failing: ${agent}`,
    agentIssueBody: (n: number) => `This agent is not answering, which affects ${n} stack${n === 1 ? "" : "s"}:`,
    capped: (shown: number, total: number) => `Only the first ${shown} of ${total} stacks are evaluated here.`,
    noChannel: {title: "Alerts are not delivered", body: "No notification channel is set as the default in the instance settings, so backup alerts are recorded but not sent."},
    countsLabel: (safe: number, attention: number, not: number) => `${safe} safe, ${attention} need attention, ${not} not protected`,
} as const;

export const SCHEDULE_EDIT = {
    heading: "Edit schedule and retention",
    open: "Edit schedule",
    cancel: "Cancel",
    save: "Save schedule",
    saving: "Saving…",
    saved: "Schedule saved. The next runs below use the new schedule.",
    savedPaused: "Schedule saved, but backups are still paused: a system administrator must activate the policy again.",
    unchanged: "Nothing changed.",
    retentionNote: "Retention applies to verified recovery points. Until the verify job ships, nothing is deleted except incomplete and failed recovery points by age.",
    reasons: {
        member: "Only a system administrator can change the schedule.",
        locked: "Configuration is locked until the single-organization check passes.",
    },
    outcome: {
        forbidden: "Only a system administrator can change the schedule.",
        not_found: "Stack not found.",
        locked: "Configuration is locked until the single-organization check passes.",
        rate_limited: "Too many attempts. Wait a moment and try again.",
        invalid_input: "Check the schedule and retention values.",
        refused: "This stack has no active backup policy to edit. Configure and activate one first.",
    } as Record<string, string>,
} as const;

/** W14 recovery kit (D25/D41). Controlled copy: every sentence on the kit page and the banner comes from here. */
export const KIT = {
    banner: {
        none: {title: "Recovery kit not created", body: "Backups can only be restored without this dashboard if you hold a recovery kit. Create one and keep it offline.", cta: "Create the recovery kit"},
        issued: {title: "Recovery kit not verified", body: "A recovery kit was created, but it has not been verified yet. Until it is, no stack can show as protected.", cta: "Verify the recovery kit"},
        stale: {title: "Recovery kit needs to be re-verified", body: "The backup keys changed or the last verification is more than 12 months old. Create a new kit or verify it again.", cta: "Open the recovery kit page"},
    },
    page: {
        title: "Recovery kit",
        intro: "The recovery kit lets you restore your backups on a new server even if this dashboard is lost. It holds the keys that read your backups: anyone with it can read them. Keep it offline.",
        notAdmin: "Only a system administrator can create or verify the recovery kit.",
        locked: "Configuration is locked until the single-organization check passes.",
    },
    states: {
        none: "No recovery kit has been created.",
        issued: "A recovery kit was created. It is not verified.",
        verified: (when: string, type: string) => `Verified on ${when} (${type} kit).`,
        stale: "The kit no longer matches the current keys or its verification expired. Create a new kit.",
    },
    types: {paper: "paper", digital: "digital file"},
    create: {
        heading: "Create a kit",
        help: "Confirm it is you, choose how to keep the kit, then print it or save the file. You can create both.",
        password: "Your account password",
        paper: "Paper (print once, keep offline)",
        digital: "Digital file (protected by a passphrase)",
        start: "Continue",
        working: "Working…",
        ready: "Confirmed. The steps below work once and expire in 5 minutes.",
        paperHeading: "Paper kit",
        paperButton: "Show the print view",
        paperNote: "The page is shown once and is not stored. If you close it without printing, create a new kit.",
        printButton: "Print",
        closeButton: "Close and forget",
        digitalHeading: "Digital kit",
        passphrase: "Passphrase (at least 14 characters, three kinds of characters, or 24 or more characters)",
        passphraseConfirm: "Repeat the passphrase",
        digitalButton: "Save the kit file",
        digitalNote: "The passphrase is never stored or shown. If you lose it, the file cannot be opened.",
        saved: "The file was saved. Keep it and its passphrase in different places.",
    },
    confirm: {
        heading: "Enter the verification code",
        help: "Run the verifier on your kit, offline, and type the short code it prints. Never type a key here. The verifier ships with the recovery tool; until then the kit stays unverified.",
        code: "Verification code (20 characters)",
        type: "Which kit did you verify?",
        button: "Check the code",
        ok: "The code matches. The kit is verified.",
    },
    errors: {
        forbidden: "Only a system administrator can do this.",
        locked: "Configuration is locked until the single-organization check passes.",
        rate_limited: "Too many attempts. Wait a moment and try again.",
        invalid_input: "Check what you entered.",
        step_up_failed: "The password is not correct.",
        no_password: "This account has no password, so it cannot confirm its identity for this step.",
        token_invalid: "This step expired or was already used. Confirm your password again.",
        weak_passphrase: "Choose a longer, less guessable passphrase.",
        no_kit: "No recovery kit has been created yet.",
        wrong_code: "That code does not match this kit.",
        code_locked: "Too many wrong codes. Try again later.",
        never_type_key: "That looks like a key. Never type a key into the dashboard; enter only the short code.",
        stale_kit: "The keys changed after this kit was made. Create a new kit first.",
        unavailable: "The keys needed for the kit could not be read. Nothing was created.",
    } as Record<string, string>,
} as const;

/** W14 D40 dashboard database backup + KEK rotation (kit page). */
export const DASHBOARD_DB = {
    heading: "Back up this dashboard's own database",
    intro: "The dashboard database holds your settings, schedules and the record of every recovery point. Back it up as an ordinary PostgreSQL source on an agent that can reach it, to a storage channel that no other host's agent uses. Pick the source below once it exists.",
    select: "Source that backs up the dashboard database",
    none: "Not chosen yet",
    save: "Save",
    saved: "Saved.",
    restoreNote: "After you restore the dashboard database on a new server: sign every user out, rotate all API keys, and rotate the storage credentials, because the old server may have been exposed.",
    verdicts: {
        not_declared: "No source is chosen. The dashboard database is not covered by a backup you can rely on.",
        ok: "Covered: a scheduled backup exists, it ran recently, and its storage is not shared with other hosts.",
        source_missing: "The chosen source no longer exists. Choose another one.",
        no_schedule: "The source has no schedule, so it is never backed up automatically.",
        no_channel: "The source has no storage channel.",
        local_only: "The source only writes to storage on the dashboard host, which is lost together with the dashboard.",
        shared_channel: "The storage is also used by another host's agent. A compromised host could delete this backup. Use a channel only this host uses.",
        no_success: "No backup of this source has succeeded yet.",
        stale: "The last successful backup is more than 48 hours old.",
    } as Record<string, string>,
    errors: {forbidden: "Only a system administrator can do this.", locked: "Configuration is locked until the single-organization check passes.", invalid_input: "Choose a source from the list.", not_found: "That source cannot be used."} as Record<string, string>,
} as const;

export const KEK_ROTATION = {
    heading: "Rotate the fork encryption key",
    intro: "Creates a new key for the secrets this fork stores (for example the Arcane API key) and re-encrypts them. The old key is kept until you retire it. The recovery kit becomes out of date: create and verify a new one afterwards.",
    password: "Your account password",
    button: "Rotate the key",
    done: (moved: number) => `Rotated. ${moved} stored secret${moved === 1 ? "" : "s"} moved to the new key. Create a new recovery kit now.`,
    errors: {forbidden: "Only a system administrator can do this.", locked: "Configuration is locked until the single-organization check passes.", rate_limited: "Too many attempts. Wait a moment and try again.", step_up_failed: "The password is not correct.", no_password: "This account has no password, so it cannot confirm its identity for this step.", invalid_input: "Enter your password."} as Record<string, string>,
} as const;

/**
 * `portabase-recover` step lines (W14b, REVISED-PLAN section 4.3 "plain-language step lines matching labels.ts"). The CLI is a bash script that cannot import
 * this module, so the lines are repeated there as `S_*` constants; `w14b-recover-static.test.ts` fails if either side drifts. Same sentences the dashboard
 * uses for the same stages (verification of a recovery point, restore stages).
 */
export const RECOVER_STEPS = {
    kit: "Reading the recovery kit",
    list: "Looking for recovery points in storage",
    signature: "Checking the signature on the recovery point",
    checksums: "Checking every backup file against its recorded checksum",
    files: "Restoring files and folders",
    volumes: "Restoring Docker volumes",
    policy: "Checking the stack's Compose file for risky settings",
    databases: "Restoring databases",
    start: "Starting the stack",
} as const;

/**
 * W17b: stop-during-backup ("Stop + copy"). Every sentence the panel, the wizard status row, Activity and Backups show for the composite quiesce task.
 * Product copy never claims a restore or a backup is "safe": it states what the agent did and what was measured.
 */
const QUIESCE_SKIP = {
    flag_off: "Stop + copy is switched off on this dashboard.", locked: "Stop + copy is paused while Stack Recovery configuration is locked.", capability_missing: "The agent on this host has not been set up for Stop + copy.",
    agent_unenrolled: "The agent is not connected to this dashboard's task channel.", plan_blocked: "The selected services cannot be stopped safely right now.", enabler_lost: "The administrator who enabled Stop + copy no longer has the right to.",
    restore_busy: "A restore is running on this host.", no_policy: "Set up and activate the backup first.", no_inventory: "There is no inventory of this stack yet.", no_agent: "This stack has no agent.",
} as const;
export const QUIESCE = {
    heading: "Stop + copy",
    intro: "While files and volumes are copied, the selected services are stopped, then started again. Databases are dumped before the stop. Off unless an administrator turns it on for this stack.",
    status: {off: "Off", on: "On", unavailable: "Unavailable"} as const,
    skip: QUIESCE_SKIP,
    unavailableBecause: (reason: string) => `Unavailable: ${reason}`,
    statusRow: {
        available: "Stop + copy: available after activation, on the Schedule tab.",
        blocked: (reason: string) => `Stop + copy: not available. ${reason}`,
    },
    fields: {services: "Services to stop", maxStop: "Longest pause", maxStopChoices: {300: "5 minutes", 600: "10 minutes", 900: "15 minutes", 1800: "30 minutes", 3600: "60 minutes"} as Record<number, string>,
        servicesHint: "Pre-selected from the stack's labels. They are only suggestions: what you tick here is what runs.", confirmName: "Type the stack name to confirm", confirmNameHint: "This host is marked as production."},
    preview: {heading: "What will happen", stopOrder: "Stop order", startOrder: "Start order", during: "Copied while the app is paused", before: "Copied before the pause", notRunning: "Not running, left alone", none: "none"},
    blockers: {
        no_services: "Choose at least one running service.", service_unknown: "A chosen service is not part of this stack.", no_container_id: "A chosen service has no known container.",
        dependency_cycle: "The chosen services depend on each other in a circle.", writer_not_stopped: "A service that writes to a copied folder is not selected, so the copy would not be paused.",
        manager_in_stack: "This stack contains Portabase, its agent or Arcane. Those are never stopped.", too_many: "At most 32 services can be stopped.", no_window_members: "There are no file or volume copies to pause the app for.",
    } as const,
    actions: {enable: "Turn on Stop + copy", disable: "Turn off Stop + copy", startNow: "Start now", save: "Save"},
    confirm: {enableTitle: "Turn on Stop + copy?", enableBody: "Backups of this stack will stop the selected services for up to the chosen time, then start them again.", disableTitle: "Turn off Stop + copy?",
        disableBody: "Backups go back to copying files while the app runs.", startNowTitle: "Start the stopped services now?", startNowBody: "The agent starts the services that this backup stopped."},
    readOnly: "Only a system administrator can change this.",
    lastResult: {heading: "Last backup with a pause", paused: (d: string, n: number) => `App paused for ${d} (${n} container${n === 1 ? "" : "s"}).`, notPaused: (why: string) => `App was not paused: ${why}`,
        outcome: {verified: "Running again", unhealthy: "Started but unhealthy", still_starting: "Started, still starting", not_running: "Did not start", replaced: "Replaced by a new container", not_running_before: "Was not running"} as const},
    states: {
        skipped: "Not paused", requested: "Waiting for the agent", stopped: "Paused", not_started: "Agent did not start it", refused: "Refused by the agent", stop_failed: "Could not stop everything",
        restarted: "Started again", restart_failed: "Some services did not start again", unconfirmed: "Not confirmed",
    } as const,
    agentCodes: {
        not_in_project: "A chosen container is not part of this stack.", protected_in_project: "This stack contains Portabase, its agent, Arcane or a container with Docker access. Nothing was stopped.", container_changed: "A chosen container changed since the plan.",
        replica_not_listed: "A second copy of a chosen service is running.", container_unstable: "A chosen container is paused or restarting.", restore_owned: "A chosen container belongs to a restore.", quiesce_pending: "An earlier pause is still waiting to be resolved on the host.",
        journal_unavailable: "The agent could not write its safety journal. Nothing was stopped.", stop_failed: "A service could not be stopped.", restart_unverified: "Some services did not come back healthy.", quiesce_interrupted: "The agent was interrupted and started the services again.",
        protected_container: "A chosen container is protected and was not touched.", docker_unavailable: "The agent cannot reach Docker.", deadline_exceeded: "The pause took too long; the agent started the services again.", payload_invalid: "The request was not valid.",
        capability_missing_at_lease: "The agent no longer offers Stop + copy.", execution_error: "The agent failed unexpectedly.", lease_lost: "The agent lost contact during the pause.", expired: "The request expired before the agent picked it up.", agent_did_not_start: "The agent did not pick up the request in time.",
    } as Record<string, string>,
    releasedBy: {dashboard: "Copies finished", lost_dashboard: "The dashboard no longer knew this pause", deadline: "The longest pause was reached", window_broken: "A stopped service was started by someone else", stop_failed: "A service could not be stopped", replay: "Started again after the agent restarted"} as Record<string, string>,
    alert: {line: (since: string) => `Stopped since ${since} UTC`, startNow: "Start now", mail: "Start them from the dashboard, or run docker start on the host.", manual: (names: string) => `Start them on the host: docker start ${names}`,
        agentOffline: "The agent is not reachable right now.", startInProgress: "A start request is already waiting for the agent.", nothingStopped: "Nothing is waiting to be started.",
        started: "Start requested.", requested: "The agent will start the services within a few seconds."},
    errors: {forbidden: "Only a system administrator can do this.", not_found: "Stack not found.", locked: "Configuration is locked until the single-organization check passes.", rate_limited: "Too many attempts. Wait a moment and try again.",
        invalid_input: "Check the values you entered.", flag_off: "Stop + copy is switched off on this dashboard.", not_active: "Set up and activate the backup first.", plan_blocked: "These services cannot be stopped safely.",
        confirmation_mismatch: "The name does not match. Type the stack name exactly.", nothing_stopped: "Nothing is waiting to be started.", agent_offline: "The agent is not reachable right now.", start_in_progress: "A start request is already waiting for the agent.",
        not_enabled: "Stop + copy is not turned on.", not_enrolled: "The agent is not connected.", agent_disabled: "The agent's task channel is switched off.", capability_missing: "The agent has not been set up for Stop + copy.", insecure_transport: "The dashboard address must be https.",
        signing_unavailable: "The dashboard cannot sign tasks right now.", payload_too_large: "The request is too large.",
    } as Record<string, string>,
    duration: (ms: number): string => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; },
    app: "App",
} as const;
