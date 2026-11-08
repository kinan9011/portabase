import type {SkipReason, TrRefusal, WIPE_REASONS} from "@/fork/test-restore/vocab";
import {FACET_COPY} from "@/fork/ui/labels";
import {fmtDuration} from "@/fork/ui/stacks/format";

/**
 * Copy of the Schedule-tab test-restore panel (W-TR-f). PURE: no React, no server code. Honest wording (D-F6): a test restore proves "the data was restored on the test machine
 * and checked"; it never claims the app was started. Exhaustive maps use `satisfies Record<…>` so a new vocab member breaks `tsc`.
 */
type WipeReason = (typeof WIPE_REASONS)[number];

export const TR = {
    heading: "Test restore",
    intro: "A test restore copies this stack's latest verified backup to a machine an admin marked as a test machine, checks the data, and wipes the copy. The app is never started.",
    facet: {label: FACET_COPY.testRestore.label, none: "No successful test restore yet", ago: (d: number) => (d === 0 ? "today" : `${d} d ago`),
        stale: "Out of date", staleNote: (n: number) => `No successful test restore in the last ${n} days.`},
    status: {on: "On", off: "Off", notConfigured: "Not set up", paused: "Paused"},
    rows: {status: "Schedule status", schedule: "Schedule", timezone: "Time zone", next: "Next runs", target: "Test machine", staleAfter: "Out of date after", lastSchedule: "Last scheduled run"},
    days: (n: number) => `${n} day${n === 1 ? "" : "s"}`,
    pause: {reauth_failed: "The administrator who turned it on lost the rights to run it. Turn it on again.", paused: "Paused."} as Record<string, string>,
    outcome: {started: "Started", skipped: "Did not run", waiting: "Waiting for the test machine"} as Record<string, string>,
    skip: {no_verified_rp: "No verified backup to test yet.", personal_data_no_opt_in: "Refused: this stack may contain personal data and test restores of it are not allowed.",
        test_restore_target_not_test: "Refused: the chosen machine is no longer marked as a test machine.", not_enrolled: "The test machine is not connected.", agent_disabled: "The test machine is disabled.",
        capability_missing: "The test machine's agent cannot do test restores yet (update the agent).", plan_blocked: "The restore plan was blocked. Open the restore plan for details.",
        locked: "Configuration was locked.", reauth_failed: "The administrator who turned it on lost the rights to run it.", wipe_pending: "The previous test-restore copy has not been wiped yet.",
        missed: "The machine stayed busy for the whole window, so this run was skipped.", target_busy: "The test machine was busy with another restore.", invalid_config: "The saved schedule is not valid. Edit and save it again.",
        internal_error: "Something went wrong. Try again later.", not_configured: "Test restore is not set up.", overlap: "A test restore was still running."} satisfies Record<SkipReason, string>,
    skipOther: (code: string) => `The scheduled test restore did not run (reference: ${code}).`,
    refusal: {forbidden: "You do not have permission to do this.", invalid_input: "Check the fields and try again.", locked: "Configuration is locked. Running test restores and wipes continue.",
        rate_limited: "Too many requests. Try again in a minute.", not_found: "This stack no longer exists.", target_not_test: "That machine is not marked as a test machine. An admin can mark an environment as test on the Integrations page.",
        not_enrolled: "That machine is not connected.", capability_missing: "That machine's agent cannot do test restores yet (update the agent).", not_configured: "Save the test-restore settings first.",
        wipe_pending: "Wipe the previous test-restore copy first.", personal_data_no_opt_in: "This stack may contain personal data. A system administrator must declare it has none or allow test restores.",
        no_verified_rp: "There is no verified backup to test yet.", plan_blocked: "The restore plan was blocked. Check the restore folder.", target_busy: "The test machine is busy with another restore. Try again later.",
        not_failed: "There is nothing to wipe.", internal_error: "Something went wrong. Try again later.", invalid_root: "Enter an absolute folder such as /srv/restore (no .., no trailing /)."} satisfies Record<TrRefusal, string>,
    privacyRefusal: {forbidden: "Only a system administrator can change this.", invalid_input: "Check the fields and try again.", locked: "Configuration is locked.", not_found: "This stack no longer exists."} as Record<string, string>,
    last: {heading: "Latest test restore", trigger: {schedule: "Scheduled", manual: "Started by hand"} as Record<string, string>, started: "Started", finished: "Finished",
        running: "In progress.", succeeded: "Finished: the data was restored on the test machine and checked. The app was not started.", failedPrefix: "Did not finish: ", cancelled: "Cancelled.",
        link: "Open the restore run", duration: (s: number) => `Took ${fmtDuration(s)}`},
    integrity: {checked: (n: number) => `${n} database${n === 1 ? "" : "s"} checked by the database's own integrity check.`,
        notSupported: (n: number) => `${n} database${n === 1 ? "" : "s"} not engine-checked (no checker for this engine).`,
        none: "No database engine check ran: the restored files were checked against the signed checksums only."},
    wipe: {pending: "Wipe of the copy is about to start.", running: "Wiping the copy…", verified: "Copy wiped and checked: it is gone from the test machine.",
        not_needed: "Nothing to wipe: no data was copied.", failed: (why: string) => `The copy could not be wiped: ${why} The next test restore waits until it is wiped.`},
    wipeReason: {agent_offline: "the test machine did not answer.", wipe_unverified: "the check afterwards still found the copy.", wipe_timeout: "it did not finish within 24 hours.",
        reauth_failed: "the person who started it lost the rights to wipe.", task_cancelled: "the wipe was cancelled.", execution_error: "the test machine reported an error.", internal_error: "something went wrong.",
        path_not_allowed: "the folder is not allowed on the test machine.", symlink_escape: "the folder contains an unsafe link.", root_not_shared: "the folder is not shared with the agent.",
        workspace_not_owned: "the folder was not created by this test restore, so it was left alone.", host_role_mismatch: "the machine is no longer a test machine.", docker_unavailable: "the test machine could not reach Docker.",
        deadline_exceeded: "it took too long.", restore_failed: "the test machine reported an error.", payload_invalid: "the request was rejected."} satisfies Record<WipeReason, string>,
    privacy: {heading: "Personal data", question: "Does this stack contain personal data?", yes: "Yes", no: "No", unset: "Not declared (treated as yes)",
        optIn: "Allow data-only test restores of this stack's personal data", optInNeedsYes: "Not needed: the stack is declared to hold no personal data.",
        d44: "Production data reaches a test host only for a data-only test restore to a host an admin marked as test, and is wiped afterwards.",
        refusedLine: "Test restores of this stack are refused until a system administrator declares it holds no personal data or allows test restores.",
        confirmTitle: "Allow test restores of personal data?", confirm: "Allow", save: "Save", saved: "Saved.", current: "Current declaration", optedIn: "Test restores of personal data are allowed.", notOptedIn: "Test restores of personal data are not allowed."},
    edit: {open: "Edit test restore", heading: "Test restore settings", enabled: "Run test restores on this schedule", target: "Test machine",
        noCandidates: "No test machine yet: an admin must mark an environment as a test machine on the Integrations page.", root: "Restore folder on the test machine",
        rootHint: "An absolute folder the test machine allows restores into. Each copy is wiped after its test restore.", stale: "Mark out of date after (days)", chooseTarget: "Choose a test machine",
        save: "Save", saving: "Saving…", cancel: "Cancel", saved: "Saved.", needTargetRoot: "To turn it on, choose a test machine and a restore folder."},
    actions: {runNow: "Run test restore now", started: "Test restore started.", wipeNow: "Wipe now", wipeArmed: "Wipe requested. It starts within a minute."},
    reasons: {member: "Only an organization administrator can start a test restore.", configure: "Only a system administrator who is also an organization administrator can change test-restore settings.",
        privacy: "Only a system administrator can change this.", locked: "Configuration is locked. Running test restores and wipes continue.", active: "A test restore is in progress.",
        notConfigured: "Save the test-restore settings first.", wipeFirst: "Wipe the previous test-restore copy first."},
} as const;

export const wipeReasonText = (r: string | null): string => (r && Object.hasOwn(TR.wipeReason, r) ? TR.wipeReason[r as WipeReason] : TR.wipeReason.internal_error);
export const skipText = (r: string | null): string => (r && Object.hasOwn(TR.skip, r) ? TR.skip[r as SkipReason] : r ? TR.skipOther(r) : TR.skip.internal_error);
export const refusalText = (c: string | undefined): string => (c && Object.hasOwn(TR.refusal, c) ? TR.refusal[c as TrRefusal] : TR.refusal.internal_error);
