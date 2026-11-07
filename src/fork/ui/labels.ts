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
    stacksUnknown: "—",
    stacksUnknownReason: "Counts appear once discovery and backup policies exist.",
    discoveryHelp: "Discovered means visible in Arcane. Backed up means a Portabase policy exists. Neither is shown until those features ship.",
    enableHelp: "Enabled environments are included in discovery once sync is available.",
    staleEnvironment: "Not covered by the current key",
} as const;

export const SYNC_NOW = {label: "Sync now", disabledReason: "Discovery sync is not available yet in this release."} as const;
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
