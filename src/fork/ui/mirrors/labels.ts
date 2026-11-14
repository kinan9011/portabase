import type {MirrorRefusalCode} from "@/fork/mirror/service";
import type {Gate, MirrorStatus, MirrorStep, MIRROR_REASONS} from "@/fork/mirror/vocab";
import type {MIRROR_AGENT_CODES} from "@/fork/restore-tasks/codes";

/**
 * Copy of the W22b "Create test mirror" wizard and progress page (plan-W22b DD-2/DD-7, ADR-009 §4). Plain sentences, no value, no path. The exhaustive records make tsc fail when a new
 * code is added to the closed lists of the mirror engine without a sentence. Pure module (client components import it).
 */
export type EnvActionKey = "keep" | "keep_exact" | "rotate" | "disable" | "drop";
export type MirrorReasonCode = (typeof MIRROR_REASONS)[number] | (typeof MIRROR_AGENT_CODES)[number];
export type RunnerReasonKey = "not_a_runner" | "not_enrolled" | "agent_disabled" | "not_attested" | "agent_mapped_to_environment" | "agent_has_databases" | "offline" | "not_isolated" | "isolation_unknown" | "no_targets" | "busy" | "no_ports";

/** ADR-009 §4, exact. */
export const BANNER = (runnerName: string): string => `This mirror contains a copy of real production data, including personal data. It lives only on the runner \`${runnerName}\`. Do not share access.`;

export const MIRROR_FLAG_OFF = "Test mirrors are not enabled on this installation.";

export const MIRRORS = {
    page: {title: "Create test mirror", loadError: {title: "Could not load this page", body: "Something went wrong while reading the data. Reload the page; if it keeps happening ask an administrator."}},
    entry: {
        role: "Creating test mirrors is limited to organization admins.",
        locked: "Configuration is locked, so new test mirrors cannot start.",
        noVerified: "A test mirror needs a verified recovery point. This stack has none yet.",
        noRunner: "No test-mirror runner is set up. A system administrator designates one.",
    },
    steps: {
        indicator: "Create test mirror: steps",
        short: {source: "Source", runner: "Runner", access: "Access", data: "Data", review: "Review"},
        title: {source: "Choose the backup to copy", runner: "Choose the runner", access: "Isolation and access", data: "Data and integrations", review: "Review and create"},
        of: (n: number, name: string) => `Step ${n} of 5: ${name}`,
        back: "Back",
        next: {runner: "Next: choose the runner", access: "Next: isolation and access", data: "Next: data and integrations", review: "Next: review", create: "Create test mirror"},
        chooseBackup: "Choose a backup first.",
        chooseRunner: "Choose a runner first.",
    },
    gone: "Something you had chosen is no longer available (it was removed, is not verified, or is not selectable). Choose again.",
    noStack: "Open an app and choose Create test mirror there.",
    noStackLink: "Go to your apps",
    source: {
        verifiedOnly: "Only a verified recovery point can be mirrored.",
        none: "This app has no verified recovery point yet.",
        newest: "newest",
        unverified: "Not available",
        privacy: {
            heading: "Personal data",
            yes: "This app is marked as containing personal data.",
            unknown: "It is not known whether this app contains personal data. It is treated as if it does.",
            no: "This app is marked as not containing personal data.",
            optedIn: "Test mirrors of this app are allowed.",
            needsOptIn: "Test mirrors of an app that may contain personal data must be allowed once by a system administrator.",
            allow: "Allow test mirrors of this app",
            allowTitle: "Allow test mirrors of this app?",
            allowBody: "A test mirror holds a copy of real production data, including personal data, on the runner you choose. It never leaves the runner. Only people who can open the runner can reach it. You can switch this off later.",
            allowConfirm: "Allow",
            allowDone: "Test mirrors of this app are now allowed.",
            adminOnly: "A system administrator must allow test mirrors of this app first, because it may contain personal data.",
            failed: "Could not change this setting. Try again or ask an administrator.",
        },
    },
    runner: {
        empty: "No test-mirror runner is set up.",
        emptyAdmin: "Designate a runner: see the operator README, section Mirrors.",
        emptyMember: "A system administrator designates a runner.",
        facts: {
            online: "Online", degraded: "Slow to respond", offline: "Offline",
            isolated: (when: string) => `Isolated (checked ${when})`,
            notIsolated: (n: number) => `Not isolated: ${n} blocked address${n === 1 ? " is" : "es are"} reachable`,
            unknown: "Isolation not checked yet",
            targets: (n: number) => `${n} address${n === 1 ? "" : "es"} checked`,
            held: (n: number) => `${n} mirror${n === 1 ? "" : "s"} held`,
            ports: (n: number) => `${n} free port${n === 1 ? "" : "s"} (41000-41999)`,
            limits: "Each container: 1 GiB memory, 512 processes, 1 CPU",
            disk: "Disk and memory: not reported by the runner",
            busy: "Busy creating another mirror",
        },
        check: "Run isolation check",
        checking: "Checking isolation…",
        checkRequested: "Isolation check requested. This page refreshes while it runs.",
        checkFailed: "Could not request the isolation check.",
    },
    access: {
        isolation: "Strict: the mirror runs on its own internal networks; the runner's firewall blocks production, mail, webhooks and DNS (checked before Ready).",
        reach: "Reachable only on the runner's loopback address (a port from 41000-41999 is assigned when you create it), through an SSH tunnel. No public address.",
        service: "App service",
        port: "Port the app listens on",
        portFree: "Port number (1-65535)",
        path: "Health check page",
        pathHelp: "A web path that must answer. Starts with /.",
        pathInvalid: "Use a path that starts with / and has no spaces.",
        noHttp: "No web page (only check that the port answers)",
        noService: "This backup records no service with a TCP port, so the mirror cannot be reached. Choose another backup.",
        limits: "Resource limits per container: 1 GiB memory, 512 processes, 1 CPU. They cannot be changed in this release.",
    },
    data: {
        intro: "Choose what happens to each setting of the app. The recommended choice is already selected.",
        recommended: "(recommended)",
        noEnv: "This service records no settings.",
        typed: (phrase: string) => `Type ${phrase} to confirm`,
        typedHelp: "Keeping a production value means the mirror uses the real production credential or address. Type the phrase exactly.",
        facts: [
            "Credentials are replaced by test values created on the runner; nobody, including Portabase, sees them.",
            "Settings found only in env files get the safe default automatically.",
            "No masking: the mirror contains real production data.",
        ],
        service: (name: string) => `Service ${name}`,
        keys: (n: number) => `${n} setting${n === 1 ? "" : "s"}`,
    },
    review: {
        summary: "Summary",
        source: (seq: number) => `Backup #${seq}`,
        runner: "Runner",
        access: "Access",
        changed: (n: number) => `${n} setting${n === 1 ? "" : "s"} changed from the recommended choice`,
        kept: "Production values kept",
        none: "none",
        name: "Name of the mirror",
        nameHelp: "Lowercase letters, digits and dashes (1-40 characters).",
        nameInvalid: "Use lowercase letters, digits and dashes, starting with a letter or digit (1-40 characters).",
        preview: "Check before creating",
        previewLoading: "Checking the plan…",
        previewError: "Could not check the plan. Try again.",
        again: "Check again",
        ready: "The plan is ready.",
        blocked: "The plan is blocked:",
        blockedGeneric: "The plan cannot run on this runner.",
        noInventory: "The recorded setup of this backup is missing, so it cannot be mirrored. Choose another backup.",
        isolationOk: "Runner isolation: checked and isolated.",
        isolationNo: "Runner isolation: not isolated or not checked. Run the isolation check first.",
        creating: "Creating…",
        created: "Mirror requested. Opening the progress page.",
        reasons: {
            locked: "Configuration is locked, so new test mirrors cannot start.",
            preview: "Checking the plan first.",
            blocked: "The plan is blocked. Fix the blockers above or choose another backup.",
            isolation: "The runner is not isolated. Run the isolation check first.",
            name: "Enter a valid name for the mirror.",
            keep: "Type the confirmation phrase for each kept production value.",
            ack: "Confirm that this mirror holds a copy of real production data.",
        },
    },
    progress: {
        title: "Test mirror",
        creating: "Creating test mirror",
        ready: (runner: string) => `Ready · isolated and health-checked on ${runner}`,
        readyNote: "Ready means the app started, its health checks passed and the runner's isolation check passed. It does not mean the data was restore-tested.",
        failed: "The mirror could not be created",
        blocked: "The mirror was blocked",
        cancelled: "Creation was cancelled",
        steps: "Steps",
        gates: "Safety checks",
        services: "Services",
        wipe: {verified: "The copy on the runner was deleted and checked.", not_needed: "Nothing was copied to the runner.", failed: "Deleting the copy on the runner failed. Retry the wipe.", running: "Deleting the copy on the runner…"},
        wipeAdmin: "Wipe failed: ask an administrator.",
        refusals: "What stopped it",
        cancel: "Cancel creation",
        cancelTitle: "Stop creating this mirror?",
        cancelBody: "The copy on the runner is deleted and checked.",
        cancelConfirm: "Stop creating",
        cancelRequested: "Cancel requested.",
        retry: "Retry wipe",
        retryDone: "Wipe retry requested.",
        access: "Show how to connect",
        accessTitle: "How to connect",
        accessCopy: "Copy",
        accessCopied: "Copied.",
        accessFailed: "Could not read the connection details.",
        accessNote: "Every time you open this, it is recorded in the audit log.",
        actionFailed: "That did not work. Try again.",
        pollError: "Could not refresh. Showing the last known state.",
        updated: "Updated",
        step: {status: {pending: "waiting", running: "in progress", done: "done", failed: "failed"} as Record<string, string>},
        gate: {ok: "passed", notReached: "not reached", failed: (code: string) => `failed (${code})`},
        gone: "This mirror could not be found.",
        unauthorized: {title: "No access", body: "Your role cannot open this mirror."},
    },
    // ---- W23: list, detail tabs, lifecycle ------------------------------------------------------------------------------------------------
    list: {
        title: "Test mirrors",
        intro: "Isolated copies of your apps, started from a backup on a test-mirror runner.",
        banner: "Test mirrors contain copies of real production data, including personal data. They live only on their runner. Do not share access.",
        flagOff: "Test mirrors are not enabled on this installation. Existing mirrors can still be stopped and deleted.",
        loadError: {title: "Could not load the test mirrors", body: "Something went wrong while reading the data. Reload the page; if it keeps happening ask an administrator."},
        unauthorized: {title: "No access", body: "Your role cannot see test mirrors."},
        empty: {title: "No test mirrors yet.", manager: "Open an app and choose Create test mirror to start one.", link: "Open the apps"},
        counts: {label: "Summary", healthy: "Healthy", stopped: "Stopped", attention: "Needs attention"},
        region: "Table of test mirrors",
        cols: {name: "Name", stack: "Source app", runner: "Runner", revision: "Revision", rp: "Backup", status: "Status", access: "Private access", actions: "Actions"},
        rp: (seq: number, date: string) => `#${seq} · ${date}`,
        loopback: (runner: string) => `Loopback only · on ${runner}`,
        connect: "How to connect",
        open: "Open",
        reload: "Reload",
        lastFailed: "Last attempt failed",
        newMirror: "Test mirrors are created from an app's page.",
    },
    detail: {
        tabs: {label: "Test mirror sections", overview: "Overview", configuration: "Configuration", history: "Refresh History", logs: "Logs"},
        deleted: "This test mirror was deleted. Its copy on the runner was removed and checked.",
        back: "All test mirrors",
        loadError: {title: "Could not load this mirror", body: "Something went wrong while reading the data. Reload the page; if it keeps happening ask an administrator."},
        failedNewer: (seq: number, activeSeq: number, why: string) => `The newer revision #${seq} failed. ${why} Revision #${activeSeq} is still the active one.`,
    },
    health: {
        text: {healthy: "Healthy", degraded: "Degraded", not_running: "Not running", pending: "Checks pending", failed: "Failed", unknown: "Unknown"} as Record<string, string>,
        at: (when: string) => `at last check ${when}`,
        note: "Health is shown as of the last check; it is not re-checked while the mirror runs.",
    },
    facet: {
        fresh: (days: number) => `App start-tested · ${days} d ago`,
        stale: (days: number) => `App start-tested · Out of date (${days} d ago)`,
        fromRp: (seq: number) => `From backup #${seq}`,
        meaning: "The app started from this backup on an isolated runner and passed its health, data and isolation checks. This is not a full restore test.",
    },
    config: {
        access: "Access", accessValue: (port: number, runner: string) => `127.0.0.1:${port} on ${runner}`, accessNone: "No access service is set.",
        healthPath: "Health check path", healthPathNone: "Only checks that the port answers.",
        limits: "Resource limits", limitsValue: (mem: string, pids: number, cpus: string) => `${mem} memory · ${pids} processes · ${cpus} CPU`,
        profile: "Isolation profile", profileValue: "Strict: the mirror has its own private network with no way out, and listens on the runner's loopback only.",
        evidence: "Isolation evidence", evidenceNote: "The five safety checks of the active revision.", notReached: "not reached",
        runnerNow: "Runner isolation now",
        runnerState: {isolated: (when: string) => `Isolated (checked ${when})`, not_isolated: "Not isolated", unknown: "Unknown (no recent check)"},
        env: "Settings changed from the safe default", envTable: "Table of changed settings", envNone: "No setting was changed from the safe default.",
        envCounts: (changed: number, kept: number) => `${changed} setting${changed === 1 ? "" : "s"} changed from the safe default; ${kept} production value${kept === 1 ? "" : "s"} kept.`,
        envKept: "production value kept",
        footer: "Settings not listed use the safe default (test credentials, side effects switched off).",
    },
    history: {
        title: "Revisions", cols: {rev: "Revision", rp: "Backup", created: "Created", outcome: "Outcome", duration: "Duration", wipe: "Copy on the runner"},
        active: "Active", empty: "No revisions.",
        ready: "Ready (isolated, health-checked)", cancelled: "Cancelled", inProgress: "In progress",
        wipe: {verified: "Deleted and checked", not_needed: "Nothing was copied", failed: "Deleting failed", running: "Deleting…", kept: "Kept (this is the running copy)", none: "Kept"},
        note: "Each refresh builds a new revision; the active one keeps running until the new one passes its checks.",
        region: "Mirror revisions",
    },
    logs: {
        title: "Timeline", empty: "Nothing recorded yet.", reload: "Reload", region: "Mirror log", cols: {when: "When", what: "What happened", result: "Result"},
        actor: {user: "a user", system: "Portabase"}, task: "Runner task", event: "Event",
        status: {queued: "queued", leased: "running", running: "running", succeeded: "done", failed: "failed", rejected: "failed", cancelled: "cancelled", expired: "expired"} as Record<string, string>,
    },
    lifecycle: {
        delete: "Delete", deleteTitle: (name: string) => `Delete test mirror ${name}?`,
        deleteBody: (runner: string) => `The copy on the runner ${runner} is deleted, then Portabase checks that nothing is left. This cannot be undone.`,
        deleteInput: "Type the mirror name to confirm", deleteConfirm: "Delete mirror", deleteMismatch: "Type the exact name of the mirror.",
        deleting: "Deleting the mirror…", deleted: "Delete requested. The copy on the runner is being removed and checked.",
        deletingLine: "Deleting this mirror: removing its copy on the runner and checking that nothing is left.",
        stop: "Stop", stopTitle: (name: string) => `Stop test mirror ${name}?`,
        stopBody: "The app stops on the runner. Its data stays on the runner; Start brings it back after isolation and health checks.",
        stopConfirm: "Stop mirror", stopped: "Stop requested.", stoppingLine: "Stopping the mirror…", stoppedLine: "The mirror is stopped. Its data stays on the runner.",
        start: "Start", started: "Start requested.", startingLine: "Starting the mirror: isolation, health and app checks…",
        startNote: "Start checks isolation, container health and the app; it does not re-check the data.",
        stopFailedLine: "Some containers may still be running. Try Stop again or Delete the mirror.",
        startFailedLine: (reason: string) => `The last start did not complete: ${reason} The mirror is stopped.`, lastStopFailed: (reason: string) => `The last stop did not complete: ${reason}`,
        stopRequested: "Stopping the mirror…", startRequested: "Starting the mirror…",
        working: "Working…", failed: "That did not work. Try again.",
        reasons: {
            cancelFirst: "Cancel creating it first.", busy: "Wait for the running action to finish.", locked: "Configuration is locked.",
            startLocked: "Configuration is locked, so a mirror cannot start.",
        },
    },
} as const;

/** Mirror status words (exhaustive over the closed list: tsc forces a sentence for every new status). */
export const STATUS_TEXT: Record<MirrorStatus, string> = {
    creating: "Creating", ready: "Ready", failed: "Needs attention", cancelled: "Cancelled", refreshing: "Refreshing", deleting: "Deleting", deleted: "Deleted",
    stopping: "Stopping", stopped: "Stopped", starting: "Starting", rolling_back: "Rolling back",
};
export const statusText = (s: string): string => (Object.hasOwn(STATUS_TEXT, s) ? STATUS_TEXT[s as MirrorStatus] : s);

export const ENV_ACTION_TEXT: Record<EnvActionKey, string> = {
    keep: "Keep",
    rotate: "Replace with a test value",
    disable: "Switch off",
    drop: "Remove",
    keep_exact: "Keep the production value",
};

export const RUNNER_REASON_TEXT: Record<RunnerReasonKey, string> = {
    not_a_runner: "This agent is not designated as a test-mirror runner.",
    not_enrolled: "This runner is not connected to the dashboard.",
    agent_disabled: "This runner's channel is switched off.",
    not_attested: "This runner has not reported that it can run mirrors.",
    agent_mapped_to_environment: "This agent also manages an environment, so it cannot be a runner.",
    agent_has_databases: "This agent also backs up databases, so it cannot be a runner.",
    offline: "This runner is offline.",
    not_isolated: "The runner is not isolated from production. Fix its firewall and run the isolation check.",
    isolation_unknown: "The runner's isolation has not been checked recently. Run the isolation check.",
    no_targets: "No addresses to protect are set for this runner, so isolation cannot be proven.",
    busy: "This runner is busy creating another mirror.",
    no_ports: "This runner has no free loopback port left.",
};

export const ISOLATION_UNKNOWN_TEXT: Record<string, string> = {
    never_probed: "Isolation has not been checked yet.",
    probe_pending: "An isolation check is running.",
    probe_failed: "The last isolation check failed to run.",
    inconclusive: "The last isolation check was inconclusive.",
    result_invalid: "The last isolation check returned an invalid result.",
    stale: "The last isolation check is too old.",
    targets_changed: "The protected addresses changed since the last check.",
    not_a_runner: "This agent is not a designated runner.",
    not_attested: "This runner has not reported that it can run mirrors.",
};
export const isolationUnknownText = (reason: string | null): string => (reason !== null && Object.hasOwn(ISOLATION_UNKNOWN_TEXT, reason) ? ISOLATION_UNKNOWN_TEXT[reason] as string : RUNNER_REASON_TEXT.isolation_unknown);

export const MIRROR_REFUSAL_TEXT: Record<MirrorRefusalCode, string> = {
    forbidden: "You do not have permission to create test mirrors.",
    not_found: "This app or backup could not be found.",
    invalid_input: "Some choices are not valid. Go back and check them.",
    locked: "Configuration is locked, so new test mirrors cannot start.",
    rate_limited: "Too many attempts. Try again shortly.",
    mirrors_disabled: MIRROR_FLAG_OFF,
    privacy_ack_required: "Confirm that this mirror will hold a copy of real production data.",
    confirmation_mismatch: "A kept production value was not confirmed by typing its exact phrase.",
    runner_ineligible: "This runner cannot be used for test mirrors.",
    runner_not_isolated: "The runner has no fresh passing isolation check. Run the isolation check.",
    runner_busy: "This runner is already creating another mirror.",
    name_taken: "A mirror with this name already exists. Choose another name.",
    port_unavailable: "No free loopback port is left on this runner.",
    rp_not_verified: "Only a verified recovery point can be mirrored.",
    mirror_not_ready: "The mirror is not ready.",
    plan_blocked: "The restore plan for this mirror is blocked.",
    not_active: "This mirror is no longer being created.",
    mirror_mode_invalid: "This backup cannot be mirrored.",
    mirror_target_not_runner: "This agent is not a test-mirror runner.",
    personal_data_no_mirror_opt_in: "A system administrator must allow test mirrors of this app first.",
    not_failed: "There is nothing to retry.",
    rp_purged: "This backup was deleted.",
    mirror_busy: "Stop creating it first (Cancel), or wait for the running action to finish.",
    mirror_state_invalid: "This action is not possible in the mirror's current state.",
    rp_not_newer: "Choose a recovery point newer than the one this mirror runs.",
    no_rollback_target: "There is no earlier revision to roll back to.",
};
const GENERIC_REFUSAL = "The mirror could not be created. Try again or check the runner.";
export const refusalText = (code: unknown): string => (typeof code === "string" && Object.hasOwn(MIRROR_REFUSAL_TEXT, code) ? MIRROR_REFUSAL_TEXT[code as MirrorRefusalCode] : GENERIC_REFUSAL);
export const retryText = (code: unknown, seconds: unknown): string => (code === "rate_limited" && typeof seconds === "number" ? `Too many attempts. Try again in ${seconds} s.` : refusalText(code));

export const STEP_TEXT: Record<MirrorStep, string> = {
    verify_manifest: "Check the backup and the runner",
    probe: "Check the backup and the runner",
    stage: "Copy the backup to the runner",
    apply: "Restore files",
    render: "Make the app safe to run (test credentials, side effects off)",
    compile: "Make the app safe to run (test credentials, side effects off)",
    finalize: "Make the app safe to run (test credentials, side effects off)",
    restore_db: "Restore the database",
    up: "Start the app",
    check: "Health checks",
    isolation: "Isolation check",
    activate: "Make it available",
};
export const stepText = (name: string): string => (Object.hasOwn(STEP_TEXT, name) ? STEP_TEXT[name as MirrorStep] : name);

export const GATE_TEXT: Record<Gate, string> = {
    expected_data: "Expected data is present",
    db_health: "Database is healthy",
    app_smoke: "App answers its health check",
    isolation: "Runner is isolated",
    side_effects: "Mail, webhooks and other side effects are off",
};

const GENERIC_REASON = "The mirror stopped. Check the runner and try again.";
export const REASON_TEXT: Record<MirrorReasonCode, string> = {
    plan_blocked: "The restore plan is blocked.",
    stop_incomplete: "Some containers could not be stopped and may still be running.",
    insufficient_disk: "The runner does not have enough free disk space for this copy.",
    insufficient_memory: "The runner does not have enough free memory to build a second revision.",
    capacity_unknown: "The runner did not report its free disk space and memory.",
    route_failed: "The private access route could not be switched.",
    route_target_not_running: "The app to switch access to is not running.",
    route_not_owned: "The access route on the runner is not owned by this mirror.",
    route_incomplete: "The private access route could not be switched or removed completely.",
    route_smoke_failed: "The app did not answer through the new access route.",
    compile_refused: "The app cannot be mirrored safely.",
    kept_secret_unconfirmed: "A kept production secret was not confirmed.",
    final_view_invalid: "The prepared app did not match what was planned.",
    limits_invalid: "The resource limits are not valid.",
    service_not_running: "A service did not start.",
    service_unhealthy: "A service did not become healthy.",
    smoke_failed: "The app did not answer its health check.",
    expected_data_failed: "The expected data was not found after the restore.",
    runner_not_isolated: "The runner is not isolated from production.",
    runner_ineligible: "The runner can no longer be used for mirrors.",
    probe_stale: "The runner's isolation check is too old.",
    rp_not_verified: "The backup is no longer verified.",
    reauth_failed: "You no longer have permission to continue this mirror.",
    run_timeout: "Creating the mirror took too long.",
    cancelled: "Creation was cancelled.",
    mirrors_disabled: MIRROR_FLAG_OFF,
    render_missing: "The runner did not return the prepared app.",
    policy_refused: "The mirror policy was refused.",
    manifest_unavailable: "The backup's list of contents is not available.",
    agent_offline: "The runner went offline.",
    task_cancelled: "A step was cancelled.",
    execution_error: "A step failed on the runner.",
    internal_error: "Something went wrong inside Portabase.",
    payload_too_large: "The app description is too large.",
    port_unavailable: "No free loopback port is left on the runner.",
    stage_mismatch: "The copied backup did not match the original.",
    plan_tampered: "The plan changed after it was made, so it was stopped.",
    hash_mismatch: "A check value did not match, so it was stopped.",
    wipe_timeout: "Deleting the copy on the runner took too long.",
    wipe_incomplete: "Part of the copy on the runner could not be deleted.",
    db_restore_failed: "The database could not be restored.",
    seed_invalid: "The runner rejected the step.",
    source_changed: "The backup changed while it was being copied.",
    apply_failed: "Restoring the files failed.",
    final_view_mismatch: "The prepared app did not match what was planned.",
    credential_reset_failed: "Test credentials could not be created.",
    credential_reset_unsupported: "This database type does not support test credentials yet.",
    smoke_failed_internal: "The app did not answer its health check.",
    mirror_disabled: "Mirrors are switched off on the runner.",
};
export const reasonText = (code: string | null): string => (code !== null && Object.hasOwn(REASON_TEXT, code) ? REASON_TEXT[code as MirrorReasonCode] : GENERIC_REASON);

// ---- Logs tab: fixed sentences for timeline events and journal rows (the loader never returns free text) -----------------------------------
const STATE_WORD: Record<string, string> = {
    requested: "Requested", planning: "Planning", validating: "Checking the backup and the runner", staging: "Copying the backup to the runner", restoring_files: "Restoring files",
    transforming: "Making the app safe to run", restoring_db: "Restoring the database", starting: "Starting the app", healthchecking: "Running health checks", ready: "Ready",
    blocked: "Blocked", failed: "Failed", cancelled: "Cancelled", rolled_back: "Rolled back",
};
const EVENT_TEXT: Record<string, string> = {
    requested: "Creation requested", gate_passed: "A safety check passed", gate_failed: "A safety check failed", blocked: "Creation blocked", failed: "Creation failed",
    cancel_requested: "Cancel requested", cancelled: "Creation cancelled", ready: "Mirror ready", wipe_started: "Deleting the copy on the runner",
    wipe_verified: "The copy on the runner was deleted and checked", wipe_failed: "Deleting the copy on the runner failed",
    activated: "Became the active revision", retired: "Retired (will be wiped)", rolled_back: "Rolled back",
};
export const eventTitle = (kind: string, toState: string | null, mirrorScope: boolean): string => {
    if (kind === "state_changed" && toState) return mirrorScope ? `Mirror status: ${statusText(toState)}` : (STATE_WORD[toState] ?? statusText(toState));
    return Object.hasOwn(EVENT_TEXT, kind) ? (EVENT_TEXT[kind] as string) : "Event";
};
const TASK_STEP_TEXT: Record<string, string> = {
    probe: "Check the backup and the runner", stage: "Copy the backup to the runner", apply: "Restore files", render: "Prepare the safe version of the app", finalize: "Make the app safe to run",
    restore_db: "Restore the database", up: "Start the app", check: "Health checks", isolation: "Isolation check", wipe: "Delete the copy on the runner", wipe_check: "Check that the copy is gone",
    stop: "Stop the app", route: "Switch private access",
};
export const taskTitle = (step: string, attempt: number): string => `${Object.hasOwn(TASK_STEP_TEXT, step) ? (TASK_STEP_TEXT[step] as string) : step}${attempt > 1 ? ` (attempt ${attempt})` : ""}`;
