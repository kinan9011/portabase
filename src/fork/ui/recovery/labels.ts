import type {BuildFailure} from "@/fork/policy/approval";
import type {RestoreRefusalCode} from "@/fork/restore-tasks/enqueue";
import {RESTORE_REASONS, type RestoreReason} from "@/fork/restore-tasks/codes";
import type {ResultReason} from "@/fork/agent-channel/tasks";
import {ACTION_KINDS, ACTION_OPS, DENY_RULE_IDS, PRECONDITIONS, PRECONDITION_STATES, REASONS, REFUSALS, type Reason, type Refusal} from "@/fork/restore/vocab";
import {ORCH_REASONS, RESTORE_RUN_STATES, RESTORE_STEPS, type RestoreRunState, type RestoreStep} from "@/fork/restore-run/vocab";
import type {CancelRefusal, CleanupRefusal, PolicyRefusal, StartRefusal} from "@/fork/restore-run/service";
import type {Tone} from "@/fork/ui/tone";

/**
 * Every sentence of the Stack Recovery restore wizard (W18-D copy deck, English only: OD-W18D-7). Plain words: no internal vocabulary, no raw code as the main
 * text (a code appears only as a "Reference:" suffix, DD-12). Shared labels (RP status, facets, host roles, agent status, service states) are IMPORTED by the
 * components from `ui/labels.ts`, never copied here. Every code → sentence map is typed over the backend's exported union, so a new backend code breaks
 * `typecheck:fork`.
 */

export const R_ROLE = "Restoring is limited to organization admins. Ask an organization owner or administrator.";
export const R_PROD = "Only the organization owner or a system administrator can confirm a restore to a production machine.";
export const R_LOCKED = "Configuration is locked, so new restores cannot start. Running restores continue.";
export const CHOICE_GONE = "That choice is no longer available. Choose again.";

// ---- the 39 "Key labels" of the W18-D copy deck (test anchor: the owner doc's Arabic column is checked against these keys) -------------------------
export const COPY_DECK = {
    "nav": "Recovery",
    "page.title": "Stack Recovery",
    "page.start": "Restore an app",
    "steps.app": "Which app do you want back?",
    "steps.backup": "Which backup?",
    "steps.machine": "Which machine should run it?",
    "steps.plan": "Here is what will happen",
    "steps.go": "Start the restore",
    "machine.folder": "Folder on that machine for the restored app",
    "machine.name": "Name of the app on that machine",
    "machine.wasSource": "This is where the app ran before",
    "machine.noRole": "No role set — treated as a production machine",
    "machine.ready": "Ready for restores",
    "plan.list": "Before the restore can start",
    "item.blocked": "Must be fixed",
    "item.needsConfirm": "Needs your confirmation",
    "item.approved": "Approved",
    "item.willAsk": "You will be asked during the restore",
    "item.valuesMissing": "N values missing",
    "plan.what": "What will be restored",
    "plan.values": "Values for this restore (optional)",
    "go.typed": "Type RESTORE <project> to confirm",
    "go.allow": "Type ALLOW <service> to allow",
    "run.inProgress": "Restore in progress",
    "run.awaiting": "Waiting for your approval",
    "run.started": "Restore finished — the app was started",
    "run.dataOnly": "Restore finished — data only, the app was not started",
    "run.incomplete": "Finished with problems — some services are not running",
    "run.failed": "Restore failed",
    "run.cancelled": "Restore cancelled",
    "run.cancelling": "Cancelling — the current step finishes first",
    "run.cleanup": "Remove what this restore created",
    "run.next": "Next steps",
    "run.protectAgain": "Protect the new machine again",
    "step.notRun": "Not run",
    "step.waitingMachine": "Waiting for <machine> to pick this up",
    "facet.lastGood": "Last good backup",
    "facet.testRestore": "Data verified by test restore",
    "rp.verifying": "Backed up · verifying",
} as const;
export type CopyKey = keyof typeof COPY_DECK;
export const COPY_DECK_KEYS = Object.keys(COPY_DECK) as readonly CopyKey[];
export const copyByKey = (k: CopyKey): string => COPY_DECK[k];

// ---- screens ---------------------------------------------------------------------------------------------------------------------------------
export const RECOVERY = {
    nav: COPY_DECK.nav,
    page: {
        title: COPY_DECK["page.title"],
        intro: "Bring an app back from one of its backups, onto any machine connected to Portabase.",
        start: COPY_DECK["page.start"],
        loading: "Loading recovery information…",
        loadError: {title: "Recovery information could not be loaded", body: "Recovery information could not be loaded. Nothing was changed; reload the page."},
        restores: "Restores", noRestores: "No restore has been started yet.", open: "Open",
        apps: "Apps and their backups",
        noStacks: "No apps are known yet. Connect Arcane and run a sync on the Docker Stacks page.", noStacksLink: "Open Docker Stacks",
        nothingVerified: "Nothing can be restored yet: no backup has been verified.",
        restoreApp: "Restore…", noVerified: "No verified backup yet", verifyingOnly: "Backed up · verifying",
        verifiedCount: (n: number) => `${n} verified backup${n === 1 ? "" : "s"}`,
        ranOn: (env: string) => `Ran on ${env}`, startedAt: "Started", duration: "Took",
        lockedBanner: R_LOCKED,
    },
    steps: {
        app: COPY_DECK["steps.app"], backup: COPY_DECK["steps.backup"], machine: COPY_DECK["steps.machine"], plan: COPY_DECK["steps.plan"], go: COPY_DECK["steps.go"],
        indicator: "Restore steps", short: {app: "App", backup: "Backup", machine: "Machine", plan: "Plan", go: "Start"},
        of: (n: number, name: string) => `Step ${n} of 5 · ${name}`,
        back: "Back", chooseFirst: "Choose an app first", chooseBackupFirst: "Choose a backup first", chooseMachineFirst: "Choose a machine first",
        nextBackup: "Next: choose the backup", nextMachine: "Next: choose the machine", nextPlan: "Next: see what will happen", preparing: "Preparing the plan…",
    },
    app: {
        empty: "There is nothing to restore yet. An app appears here once one of its backups is verified.", emptyLink: "Open Docker Stacks",
        notRestorable: "Not restorable yet",
    },
    backup: {
        stored: (names: string[]) => `Stored in: ${names.join(", ")}`, noneLeft: "This app has no verified backup any more. Choose another app.", newest: "Newest verified backup",
        gone: "This backup can no longer be used. Choose another backup.",
    },
    machine: {
        folder: COPY_DECK["machine.folder"], name: COPY_DECK["machine.name"], wasSource: COPY_DECK["machine.wasSource"], noRole: COPY_DECK["machine.noRole"], ready: COPY_DECK["machine.ready"],
        production: "Production machine", test: "Test machine",
        folderHelp: "Use a folder the Portabase agent on that machine may restore into (set when the agent was installed). The app gets its own sub-folder inside it.",
        nameHelp: "Change it to restore next to an app with the same name. Leave it empty to keep the original name.", more: "More options",
        offlineWarning: "This machine has not been in touch recently. The restore will wait for it (up to 3 tries) and then stop.",
        empty: "No machine is connected to Portabase yet. A system administrator must install an agent on the new machine and connect it on the Agent channel page.",
        fixHint: "A system administrator can fix this on the Agent channel page.", fixLink: "Agent channel page",
        notReady: {
            ready: "Ready for restores",
            archived: "This machine was archived, so it can no longer be used for restores.",
            revoked: "Access for this machine was revoked, so it can no longer be used for restores.",
            not_enrolled: "This machine is not connected for restores.",
            channel_disabled: "Restores are switched off for this machine.",
            capability_missing: "The Portabase agent on this machine cannot restore.",
        } as const,
        folderRequired: "Choose the folder on the machine for the restored app.",
    },
    plan: {
        list: COPY_DECK["plan.list"], what: COPY_DECK["plan.what"], values: COPY_DECK["plan.values"],
        summary: (app: string, date: string, machine: string, project: string, folder: string | null) =>
            `Portabase will restore ${app} from the backup of ${date} onto ${machine}, as an app named ${project}${folder ? ` in ${folder}` : ""}. Nothing that already exists on ${machine} is changed: if something with the same name is there, the restore stops.`,
        validUntil: (t: string) => `This plan is valid until ${t}.`,
        stale: "Something changed since this plan was made. Make a new plan.", expired: "This plan expired. Make a new plan.", makeNew: "Make a new plan",
        ready: "Ready", blocked: (n: number) => `Blocked (${n} item${n === 1 ? "" : "s"})`,
        tampered: "This plan failed its integrity check and cannot be used. Make a new plan.", used: "This plan was already used.", usedLink: "Open that restore",
        size: (bytes: string) => `About ${bytes} to copy`,
        deferredTitle: "Checked by the machine when the restore starts",
        phases: {stage: "Files and folders", data: "Volumes", db: "Databases", start: "Start the app"} as const,
        continue: "Continue", fixBackup: "Choose another backup", fixMachine: "Choose another machine", useName: (n: string) => `Use the name ${n}`,
        valuesRateLimited: "Values could not be loaded right now. Wait a minute and reload.", valuesLocked: "Configuration is locked, so values cannot be changed now.",
        blockedGo: "This plan has items that must be fixed first.",
    },
    item: {
        blocked: COPY_DECK["item.blocked"], needsConfirm: COPY_DECK["item.needsConfirm"], approved: COPY_DECK["item.approved"], willAsk: COPY_DECK["item.willAsk"],
        valuesMissing: (n: number) => `${n} value${n === 1 ? "" : "s"} missing`,
        production: (machine: string, byDefault: boolean) => `${machine} is a production machine${byDefault ? " (no role is set, so it is treated as one)" : ""}. You confirm the restore to it when you start.`,
        valuesNeeded: "The app needs values that are not in the backup. Fill them in below, or start without them.",
        willAskSuffix: "You will be asked to allow this during the restore.",
    },
    go: {
        recapApp: (app: string, date: string) => `App: ${app}, backup of ${date}`, recapMachine: (m: string, role: string) => `Machine: ${m} (${role})`, recapFolder: (f: string) => `Folder: ${f}`,
        next: "What happens next: the machine downloads the backup, checks it is genuine, puts files, volumes and databases back, then starts the app. Large backups take longer. You can leave this page: the restore keeps running, and you find it again under Recovery.",
        acceptMissing: "Start without the missing values (the app may not work until you add them)",
        typed: COPY_DECK["go.typed"], typedLabel: "Confirmation", typedReason: "Type the phrase exactly as shown",
        prodTitle: "Restore to a production machine?", prodBody: (m: string, byDefault: boolean) => `${m} is a production machine${byDefault ? ", or has no role set and is treated as one" : ""}.`,
        typePhrase: "Type this phrase to confirm:", prodButton: (m: string) => `Restore to ${m}…`, prodConfirm: (m: string) => `Restore to ${m}`,
        testButton: "Start restore…", testTitle: (m: string) => `Start the restore onto ${m}?`, testConfirm: "Start restore",
        testBody: "The machine will download the backup and put the app back. Nothing that already exists there is changed.",
        busy: "Starting the restore…", openActive: "Open the running restore",
    },
    run: {
        title: (app: string, machine: string) => `Restoring ${app} on ${machine}`,
        started: (t: string, elapsed: string) => `Started ${t} · ${elapsed}`, deadline: (t: string) => `If it cannot finish, the restore stops by itself at ${t}.`, reference: (id8: string) => `Reference: ${id8}`,
        updated: (t: string) => `Updated ${t}`, pollError: "Could not refresh. Retrying… The restore keeps running on the server.",
        awaitingTitle: "The app asks for permissions a restore does not give by default", awaitingAllow: COPY_DECK["go.allow"], allowButton: "Allow and continue", allowLabel: (s: string) => `Type ALLOW ${s} to allow`,
        awaitingPreparing: "The app's settings are being prepared again. This page updates by itself.", allowSuffix: (m: string) => `Allow only if you trust this app to do that on ${m}.`,
        services: "Services", cancel: "Cancel restore…", cancelTitle: "Cancel this restore?", cancelBody: (m: string) => `Steps already done are not undone. Anything this restore created stays on ${m} until you remove it.`, cancelConfirm: "Cancel restore", cancelKeep: "Keep going",
        cancelling: COPY_DECK["run.cancelling"],
        cleanup: COPY_DECK["run.cleanup"], cleanupButton: "Remove what this restore created…", cleanupTitle: "Remove what this restore created?",
        cleanupBody: (m: string, incomplete: boolean) => `This removes only the containers, volumes, networks and the folder this restore created on ${m}. Nothing else is touched.${incomplete ? " The restored data is removed too." : ""}`,
        cleanupConfirm: "Remove", cleanupRetry: "Try removing again", cleanupRunning: "Removing…",
        cleanupDone: "Removed. Items that did not belong to this restore were left alone.", cleanupFailed: (why: string) => `Removal failed: ${why}`, cleanupCancelled: "Removal cancelled.",
        next: COPY_DECK["run.next"],
        nextItems: [
            "Point your DNS or open the app, and check that its data is what you expect.",
            "Protect the new machine again: until a backup on the new machine is verified, it has no fresh backup.",
            "Switch off the old machine's access to your services and storage.",
        ] as const,
        protectAgain: COPY_DECK["run.protectAgain"], protectLink: "Open Docker Stacks",
        recovered: "Restores are listed under Recovery.", openRecovery: "Back to Recovery",
    },
} as const;

// ---- run headline (table S) ------------------------------------------------------------------------------------------------------------------
export const HEADLINE = {
    running: {text: COPY_DECK["run.inProgress"], tone: "active" as Tone},
    awaiting_approval: {text: COPY_DECK["run.awaiting"], tone: "warning" as Tone},
    started: {text: "Restore finished — the app was started. All its services were running right after start.", tone: "success" as Tone},
    data_only: {text: "Restore finished — the data was restored. The app was not started.", tone: "success" as Tone},
    data_verified: {text: "Test restore finished — the data was read back and checked. The app was not started.", tone: "success" as Tone},
    succeeded: {text: "Restore finished.", tone: "success" as Tone},
    incomplete: (names: string[]) => ({
        text: `Finished with problems — the data is restored, but some services were not running right after start${names.length ? `: ${names.join(", ")}` : ""}. Some services stop on purpose after a one-time job (for example a database migration); check whether that is expected for these.`,
        tone: "warning" as Tone,
    }),
    failed: (step: string | null, why: string) => ({text: `Restore failed${step ? ` at '${step}'` : ""}: ${why}`, tone: "danger" as Tone}),
    cancelled: {text: COPY_DECK["run.cancelled"], tone: "neutral" as Tone},
} as const;
export const STATE_CHIP: Record<RestoreRunState, string> = {
    running: COPY_DECK["run.inProgress"], awaiting_approval: COPY_DECK["run.awaiting"], succeeded: "Finished", incomplete: "Finished with problems", failed: COPY_DECK["run.failed"], cancelled: COPY_DECK["run.cancelled"],
};

// ---- table T: step labels + status words -----------------------------------------------------------------------------------------------------
export const STEP_TEXT: Record<RestoreStep | "cleanup", string> = {
    verify_manifest: "Check that the backup is genuine", probe: "Check the machine", stage: "Download the backup", apply: "Put files and volumes back", render: "Prepare the app's settings",
    restore_db: "Restore the databases", compose_up: "Start the app", check_services: "Check that the app's services are running", integrity: "Check the restored data with its database engine", cleanup: COPY_DECK["run.cleanup"],
};
export const STEP_STATUS = {
    done: "Done", waiting: "Waiting", inProgress: "In progress", failed: "Failed", notRun: COPY_DECK["step.notRun"],
    waitingMachine: (machine: string) => `Waiting for ${machine} to pick this up`,
    retrying: (attempt: number, max: number) => `The machine did not respond. Trying again (attempt ${attempt} of ${max})`,
} as const;

// ---- table K: plan rows ----------------------------------------------------------------------------------------------------------------------
export const ACTION_KIND_TEXT: Record<(typeof ACTION_KINDS)[number], (name: string) => string> = {
    restore_compose_dir: () => "The app's settings folder (compose file)", restore_volume: (n) => `Volume ${n}`, restore_path: (n) => `Folder ${n}`,
    restore_db_dump: (n) => `Database ${n} (from its saved dump)`, restore_sqlite_file: (n) => `SQLite database ${n}`, stage_only: () => "Kept aside on the machine, not put into the app",
    create_network: (n) => `Network ${n}`, compose_up: () => "Start the app",
};
export const ACTION_OP_TEXT: Record<(typeof ACTION_OPS)[number], string> = {create: "Create", skip: "Not restored", stage_only: "Kept aside", replace: "Replace"};
export const PRECONDITION_TEXT: Record<(typeof PRECONDITIONS)[number], string> = {
    target_enrolled: "Machine connected for restores", target_capability_restore: "Machine can restore", target_capability_compose: "Machine can start apps",
    target_facts_fresh: "Up-to-date information about the machine", arch_compat: "Processor type matches", free_disk: "Enough free disk space", restore_root_on_agent: "Folder allowed on the machine",
    target_empty: "Nothing with the same name exists there", manifest_signature: "The backup is genuine", safety_snapshot: "Safety copy of current data",
};
export const PRECONDITION_STATE_TEXT: Record<(typeof PRECONDITION_STATES)[number], string> = {met: "Checked", unmet: "Not met", deferred: "Checked by the machine when the restore starts"};

// ---- table B: plan blockers and item reasons -------------------------------------------------------------------------------------------------
export type ReasonCtx = {machine: string; name?: string; subject?: string; roots?: string};
const cannotUse = (why: string) => `This backup cannot be used: ${why}. Choose another backup.`;
const exists = "Something with this name already exists on the machine. Portabase never changes it, so the restore would stop.";
const notAllowedHere = "This kind of restore is not available here.";
const noFreshInfo = "Portabase has no fresh information about this machine; the machine checks this itself when the restore starts.";
export const PLAN_REASON_TEXT: Record<Reason, (c: ReasonCtx) => string> = {
    manifest_unbound: () => cannotUse("it has no signed list of its contents"),
    inventory_missing: () => cannotUse("the app's recorded setup is missing or does not match"),
    inventory_mismatch: () => cannotUse("the app's recorded setup is missing or does not match"),
    required_artifact_missing: () => cannotUse("part of it is missing from storage"),
    target_agent_archived: () => "This machine can no longer be used for restores. Choose another machine.",
    target_revoked: () => "This machine can no longer be used for restores. Choose another machine.",
    target_not_enrolled: () => `This machine is not ready for restores (not connected). ${RECOVERY.machine.fixHint}`,
    target_channel_disabled: () => `This machine is not ready for restores (switched off). ${RECOVERY.machine.fixHint}`,
    target_capability_missing: () => `This machine is not ready for restores (its Portabase agent cannot restore). ${RECOVERY.machine.fixHint}`,
    compose_not_in_backup: () => "The app's compose file is not in this backup, so the app cannot be started from the dashboard. Choose another backup, or follow the recovery guide.",
    restore_root_required: () => "Choose the folder on the machine for the restored app.",
    restore_root_rejected: () => "This folder cannot be used: it is a system folder or not a full path. Choose another folder.",
    restore_root_outside_allowed_roots: (c) => `This folder is outside the folders allowed on this machine${c.roots ? ` (${c.roots})` : ""}. Choose a folder inside one of them.`,
    project_name_conflict: (c) => `An app named ${c.name ?? c.subject ?? "this"} already exists on ${c.machine}. Restore it under another name.`,
    insufficient_disk: () => "The machine does not have enough free disk space for this backup.",
    arch_mismatch: () => "This machine has a different processor type than the app needs.",
    existing_stack_not_on_target: () => notAllowedHere, nothing_selected: () => notAllowedHere, selection_unknown_key: () => notAllowedHere, replaces_existing_data: () => notAllowedHere,
    volume_exists: () => exists, network_name_conflict: () => exists, path_in_use: () => exists,
    volume_name_rejected: () => "This name or folder is not allowed on the machine.", path_rejected: () => "This name or folder is not allowed on the machine.", path_outside_allowed_roots: () => "This name or folder is not allowed on the machine.",
    allowed_roots_unknown: () => noFreshInfo, target_facts_stale: () => noFreshInfo, no_target_inventory: () => noFreshInfo,
    image_unpublished: () => "This app uses a program image that was built on the old server and is not published. The new machine cannot download it; it must be rebuilt.",
    image_unpinned: () => "This app's image has no fixed version; the new machine may download a newer one than before.",
    port_in_use: (c) => `Another app on the machine already uses network port ${c.subject ?? ""}. The app may not start until that is fixed.`.replace("port .", "port."),
    shared_network_missing: () => "The app needs a shared network that does not exist on the machine yet. Create it there first.",
    shared_network_reused: () => "The app joins a shared network that already exists on the machine.",
    sqlite_placement_unresolved: () => "The app keeps a SQLite database whose place on the new machine is not known. Follow the recovery guide for it.",
    sqlite_mapping_rejected: () => "The app keeps a SQLite database whose place on the new machine is not known. Follow the recovery guide for it.",
    artifact_unmapped: () => "Part of the backup does not match the app; it is kept aside, not put into the app.",
    optional_artifact: () => "Optional part; not restored.", not_selected: () => "Not selected.",
    restic_payload_credential: () => "This part of the backup cannot be restored from the dashboard yet.",
};

// ---- table P / G / A / C: refusals -----------------------------------------------------------------------------------------------------------
const planChanged = "Something changed since this plan was made. Make a new plan.";
const integrity = "This plan failed its integrity check. Make a new plan.";
const generic = "This restore cannot be planned like this.";
export const PLAN_REFUSAL_TEXT: Record<Refusal, string> = {
    forbidden: R_ROLE, locked: "Configuration is locked, so new restores cannot start.", rate_limited: "Too many plans in a short time. Wait a minute and try again.", not_found: CHOICE_GONE,
    rp_not_verified: RECOVERY.backup.gone, rp_purged: RECOVERY.backup.gone, stale: planChanged, expired: planChanged, hash_mismatch: integrity, plan_tampered: integrity,
    plan_blocked: RECOVERY.plan.blockedGo, invalid_input: "Some choices are not valid. Check them and try again.",
    test_restore_target_not_test: generic, personal_data_no_opt_in: generic, test_restore_mode_invalid: generic, approval_not_required: generic,
    mirror_mode_invalid: generic, mirror_target_not_runner: generic, personal_data_no_mirror_opt_in: generic,
};
const notReady = "This machine is no longer ready for restores. Choose another machine.";
export const START_REFUSAL_TEXT: Record<StartRefusal, (c: {machine: string; project: string}) => string> = {
    forbidden: () => R_ROLE, invalid_input: () => PLAN_REFUSAL_TEXT.invalid_input, locked: () => PLAN_REFUSAL_TEXT.locked, rate_limited: () => PLAN_REFUSAL_TEXT.rate_limited, not_found: () => PLAN_REFUSAL_TEXT.not_found,
    stale: () => planChanged, expired: () => "This plan expired. Make a new plan.", hash_mismatch: () => integrity, plan_tampered: () => integrity, plan_blocked: () => PLAN_REFUSAL_TEXT.plan_blocked,
    approval_missing: () => "The production confirmation is missing. Confirm again.", mode_unsupported: () => generic,
    confirmation_required: () => "Type the confirmation phrase.", confirmation_mismatch: (c) => `The phrase does not match. Type RESTORE ${c.project} exactly.`,
    inputs_missing: () => "Some values are missing. Fill them in or tick 'Start without the missing values'.",
    not_enrolled: () => notReady, agent_disabled: () => notReady, capability_missing: () => notReady,
    already_running: (c) => `Another restore is already running on ${c.machine}. Wait for it to finish.`,
    plan_used: () => "This plan was already used. Make a new plan to restore again.",
};
const settingsChanged = "The app's settings changed meanwhile. This page updates by itself; check again.";
const hardRefusal = "The app asks for something a restore never allows. This restore cannot continue from the dashboard; cancel it.";
export const POLICY_REFUSAL_TEXT: Record<PolicyRefusal, string> = {
    forbidden: R_PROD, invalid_input: PLAN_REFUSAL_TEXT.invalid_input, locked: PLAN_REFUSAL_TEXT.locked, rate_limited: PLAN_REFUSAL_TEXT.rate_limited, not_found: PLAN_REFUSAL_TEXT.not_found,
    not_awaiting: settingsChanged, render_missing: settingsChanged, render_stale: settingsChanged, plan_tampered: integrity, hash_mismatch: integrity, stale: planChanged,
    hard_refusal: hardRefusal, nothing_to_approve: "Nothing needs approval any more.", service_not_flagged: "That service does not need approval.",
    missing_confirmation: "Type ALLOW <service> for every service listed.", confirmation_mismatch: "A phrase does not match. Type ALLOW <service> exactly.",
} satisfies Record<PolicyRefusal | BuildFailure, string>;
export const CANCEL_REFUSAL_TEXT: Record<CancelRefusal, string> = {
    forbidden: R_ROLE, invalid_input: PLAN_REFUSAL_TEXT.invalid_input, locked: PLAN_REFUSAL_TEXT.locked, not_found: PLAN_REFUSAL_TEXT.not_found, not_active: "This restore has already ended.",
};
export const CLEANUP_REFUSAL_TEXT: Record<CleanupRefusal, string> = {
    not_allowed: "A finished, successful restore is not removed here: it is your restored app.", already_queued: "Removal is already in progress.", invalid_input: PLAN_REFUSAL_TEXT.invalid_input, not_found: PLAN_REFUSAL_TEXT.not_found,
    forbidden: R_ROLE, locked: PLAN_REFUSAL_TEXT.locked, rate_limited: PLAN_REFUSAL_TEXT.rate_limited, not_enrolled: notReady, agent_disabled: notReady, capability_missing: notReady,
    insecure_transport: "The machine could not be reached safely. A system administrator should check the Agent channel page.", invalid_url: "The machine could not be reached safely. A system administrator should check the Agent channel page.",
    signing_unavailable: "Portabase could not sign the instruction right now. Try again in a moment.", stale: planChanged, expired: "The plan expired. Make a new plan.", hash_mismatch: integrity, plan_tampered: integrity,
    plan_blocked: PLAN_REFUSAL_TEXT.plan_blocked, approval_missing: "The production confirmation is missing. Confirm again.", mode_unsupported: generic,
    manifest_mismatch: "The backup did not pass the authenticity check.", artifact_unavailable: "The backup storage could not be reached.", payload_too_large: "The instruction was too large for the machine.", target_mismatch: "The instruction does not match this machine.",
    raw_refused: "The app's settings ask for something a restore does not allow.", render_missing: settingsChanged, policy_refused: "The app's settings ask for something a restore does not allow.", approval_invalid: "A permission given earlier no longer matches.",
    override_conflict: "The values for this restore changed. Make a new plan.", overrides_changed: "The values for this restore changed. Make a new plan.",
} satisfies Record<CleanupRefusal, string>;

// ---- table R: directive rules ----------------------------------------------------------------------------------------------------------------
export const RULE_TEXT: Record<(typeof DENY_RULE_IDS)[number], (svc: string) => string> = {
    privileged: (s) => `${s} wants to run with full control of this machine.`,
    network_mode_host: (s) => `${s} wants to use this machine's network directly instead of its own.`,
    pid_host: (s) => `${s} wants to see and control every program running on this machine.`,
    ipc_host: (s) => `${s} wants to share memory with every program on this machine.`,
    devices: (s) => `${s} wants direct access to hardware devices of this machine.`,
    cap_add: (s) => `${s} asks for extra system permissions.`,
    docker_sock: (s) => `${s} wants full control of Docker on this machine.`,
    bind_outside_root: (s) => `${s} wants to use a folder outside the restore folder.`,
};
export const UNKNOWN_RULE = (s: string) => `${s} asks for a permission a restore does not give by default.`;

// ---- table F: failed-step reasons ------------------------------------------------------------------------------------------------------------
export type RunFailureCode = (typeof ORCH_REASONS)[number] | RestoreRefusalCode | RestoreReason | ResultReason;
type Fail = {tone: "danger" | "warning" | "neutral"; text: (machine: string) => string; reference?: boolean};
const g = <const C extends readonly string[]>(codes: C, f: Fail) => ({codes, ...f}) as const;
export const FAILURE_GROUPS = [
    g(["manifest_mismatch", "manifest_invalid", "manifest_unknown_kid", "manifest_signature", "stage_mismatch"], {tone: "danger", text: () => "The backup did not pass the authenticity check, so nothing was restored from it. Choose another backup. If this happens again, the backup storage may have been tampered with."}),
    g(["checksum_mismatch", "archive_invalid", "dump_format_mismatch"], {tone: "danger", text: () => "Part of the backup is damaged: its contents do not match what was recorded. Choose another backup."}),
    g(["manifest_unavailable", "artifact_unavailable"], {tone: "danger", text: (m) => `The backup storage could not be reached from ${m}. Check the storage and try again with a new plan.`}),
    g(["agent_offline", "deadline_exceeded", "lease_lost", "expired"], {tone: "danger", text: (m) => `${m} did not respond in time. Check that it is on and its Portabase agent runs, then try again with a new plan.`}),
    g(["root_missing", "path_not_allowed", "symlink_escape"], {tone: "danger", text: (m) => `${m} does not allow restoring into this folder. Use a folder that was allowed when its Portabase agent was installed, and make a new plan.`}),
    g(["root_not_shared"], {tone: "danger", text: (m) => `The restore folder is not visible to Docker on ${m}. Ask whoever set up the agent to share it.`}),
    g(["workspace_not_owned"], {tone: "danger", text: () => "The folder already contains something that does not belong to this restore. Choose another folder or app name."}),
    g(["insufficient_disk", "disk_full"], {tone: "danger", text: (m) => `Not enough free disk space on ${m}.`}),
    g(["compose_unavailable", "docker_unavailable"], {tone: "danger", text: (m) => `Docker with Compose is not available on ${m}.`}),
    g(["rules_mismatch"], {tone: "danger", text: (m) => `The Portabase agent on ${m} uses different safety rules than this dashboard. Update the agent.`}),
    g(["volume_exists", "volume_not_owned", "container_conflict", "network_exists", "protected_container", "volume_not_in_compose"], {tone: "danger", text: (m) => `Something with the same name already exists on ${m} and does not belong to this restore. Portabase never changes it.`}),
    g(["policy_refused", "approval_invalid", "raw_refused", "override_invalid"], {tone: "danger", text: () => "The app's settings ask for something a restore does not allow, or a permission given earlier no longer matches. Make a new plan."}),
    g(["render_failed", "render_too_large"], {tone: "danger", text: (m) => `The app's settings could not be prepared on ${m}.`}),
    g(["db_restore_failed"], {tone: "danger", text: () => "A database could not be restored."}),
    g(["compose_failed"], {tone: "danger", text: () => "The app could not be started."}),
    g(["service_not_running"], {tone: "warning", text: () => "Some services were not running right after the app was started."}),
    g(["run_timeout"], {tone: "danger", text: () => "The restore took longer than allowed and was stopped."}),
    g(["reauth_failed"], {tone: "danger", text: () => "The person who started this restore no longer has the rights to run it, so it stopped."}),
    g(["stale"], {tone: "danger", text: () => "Something changed since the plan was made (the backup, the machine or what runs on it), so the restore stopped to stay safe."}),
    g(["task_cancelled", "cancelled"], {tone: "neutral", text: () => "Cancelled."}),
    g(["override_conflict", "overrides_changed", "render_missing"], {tone: "danger", text: () => "The values for this restore changed while it ran. Make a new plan."}),
    g(["plan_tampered", "hash_mismatch"], {tone: "danger", text: () => integrity}),
    g(["integrity_failed"], {tone: "danger", text: () => "The restored data failed the database's own integrity check."}),
    g(["engine_unavailable"], {tone: "danger", text: (m) => `${m} could not run the database check.`}),
    g(["host_role_mismatch", "mode_unsupported", "approval_missing"], {tone: "danger", text: () => "The machine refused this restore for its role or a missing approval."}),
    g(["forbidden", "locked", "rate_limited", "invalid_input", "not_found", "plan_blocked"], {tone: "danger", text: () => "The restore was refused when its next step was prepared. Make a new plan and try again."}),
    g(["bad_signature", "unknown_kid", "bad_envelope", "agent_mismatch", "enroll_mismatch", "not_yet_valid", "replayed", "seq_rollback", "unsupported_type", "capability_missing", "payload_hash", "payload_invalid",
        "channel_disabled", "state_unavailable", "target_mismatch", "role_forbidden", "not_enrolled", "agent_disabled", "insecure_transport", "invalid_url", "signing_unavailable", "payload_too_large"],
        {tone: "danger", text: (m) => `${m} refused the instruction for a security reason. A system administrator should check the Agent channel page.`}),
    // fallback group: the step failed on the machine for a reason that is not worth its own sentence; the code is shown as a reference
    g(["execution_error", "restore_failed", "internal_error", "probe_invalid", "not_in_project", "protected_in_project", "container_changed", "replica_not_listed", "container_unstable", "restore_owned",
        "quiesce_pending", "journal_unavailable", "stop_failed", "restart_unverified", "quiesce_interrupted", "helper_failed", "wipe_incomplete", "stop_incomplete",
        // W22a mirror-engine codes (a restore run never gets them; the mirror UI (W22b/W23) words them itself)
        "seed_invalid", "source_changed", "apply_failed", "limits_invalid", "final_view_mismatch", "credential_reset_failed", "credential_reset_unsupported", "smoke_failed_internal", "mirror_disabled",
        // W24 mirror route codes
        "route_target_not_running", "route_not_owned", "route_incomplete", "route_smoke_failed"], {tone: "danger", reference: true, text: (m) => `The step failed on ${m}. Check the Portabase agent log there.`}),
] as const;
/** Compile-time exhaustiveness: if the backend adds a code that no group covers, this line stops compiling. */
type Covered = (typeof FAILURE_GROUPS)[number]["codes"][number];
export const _failureCodesExhaustive: Exclude<RunFailureCode, Covered> extends never ? true : never = true;
export const GENERIC_FAILURE_TEXT = (machine: string) => `The step failed on ${machine}. Check the Portabase agent log there.`;

/** Used by the unit test: every closed code list the UI must have a sentence for. */
export const VOCABULARIES = {REASONS, REFUSALS, DENY_RULE_IDS, PRECONDITIONS, ACTION_KINDS, ACTION_OPS, RESTORE_STEPS, ORCH_REASONS, RESTORE_REASONS, RESTORE_RUN_STATES} as const;
