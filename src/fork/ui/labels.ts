import {ARCANE_PINNED_VERSION} from "@/fork/arcane/endpoints";
import type {ArcaneErrorClass} from "@/fork/arcane/errors";
import type {HostRole} from "@/fork/db/enums";
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
        configure: {label: "Configure backup", admin: "Backup configuration is not built yet. It arrives in a later step of this release.", member: "Only a system administrator configures backups, and the form is not built yet."},
        backupNow: {label: "Back up now", reason: "A backup has to be configured first, and nothing can be configured yet."},
        restore: {label: "Restore", reason: "Restoring from the dashboard is planned for release R2."},
        mirror: {label: "Create test mirror", reason: "Test mirrors are not part of this release."},
    },
    overview: {
        resources: "Resource summary",
        recovery: "Latest recovery point",
        noRecovery: "None yet",
        noRecoveryNote: "No backup exists for this stack. Discovery lists resources; it does not back them up.",
        blockers: "Backup blockers",
        blockersNote: "Backup readiness is not evaluated yet. The Configuration tab (next step) will list what blocks a safe backup.",
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
