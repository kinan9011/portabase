// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import type {ProtectionView} from "@/fork/completeness/view";
import {ActivityViewSchema, type ActivityView} from "@/fork/stacks/activity-view";
import {BackupsViewSchema, type BackupsView} from "@/fork/stacks/backups-view";
import {SafetyStripSchema, type SafetyStrip} from "@/fork/stacks/safety";
import {ACTIVITY, BACKUPS, RP_STATUS_LABELS, SCHEDULE_EDIT, STRIP} from "@/fork/ui/labels";

const refresh = vi.fn();
const start = vi.fn();
const update = vi.fn();
vi.mock("next/navigation", () => ({useRouter: () => ({refresh})}));
vi.mock("@/fork/actions/stack-run.action", () => ({startStackRunAction: (...a: unknown[]) => start(...a), cancelStackRunAction: vi.fn()}));
vi.mock("@/fork/actions/stack-schedule.action", () => ({updateStackScheduleAction: (...a: unknown[]) => update(...a)}));
vi.mock("@/fork/actions/stack-quiesce.action", () => ({previewQuiesceAction: vi.fn(), enableQuiesceAction: vi.fn(), disableQuiesceAction: vi.fn(), startQuiesceNowAction: vi.fn()}));

import {ActivityTab} from "@/fork/ui/stacks/activity/activity-tab";
import {BackupsTab} from "@/fork/ui/stacks/backups/backups-tab";
import {LastGoodBackupLine} from "@/fork/ui/stacks/config-tab/facets-panel";
import {ScheduleEditor} from "@/fork/ui/stacks/schedule/schedule-edit.client";
import {SafetyStripView} from "@/fork/ui/stacks/safety-strip/safety-strip";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const SID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const SID2 = "0b7e1c1e-7f3a-4b6e-9a40-222222222222";
const RUN = "0b7e1c1e-7f3a-4b6e-9a40-333333333333";
const LIMITS = {waitMinutes: 10, stallMinutes: 30};
beforeEach(() => { refresh.mockReset(); start.mockReset(); update.mockReset(); });
afterEach(cleanup);

const rpRow = (o: Record<string, unknown> = {}) => ({sequence: 1, createdAt: "2026-11-07T02:00:00.000Z", status: "pending_verification", reason: null, consistency: "mixed", destinations: ["Offsite S3"], sizeBytes: 5_242_880, durationSeconds: 95, required: 2, present: 2, inventoryVersion: 3, trigger: "schedule", verifiedAt: null, ...o});
const backups = (rows: Record<string, unknown>[], detail: BackupsView["detail"] = null): BackupsView => BackupsViewSchema.parse({total: rows.length, shown: rows.length, timezone: "Europe/Berlin", rows, detail});
const art = (o: Record<string, unknown> = {}) => ({source: "db", engine: "archive", kind: "archive_enc", encrypted: true, destination: "Offsite S3", sizeBytes: 1234, checksum: {recorded: true, short: "abcdef012345"}, presence: "present", required: true, ...o});

describe("Backups tab (D43 honest labels)", () => {
    it("a pending_verification recovery point reads 'Backed up · verifying' and 'Not verified yet'; only `verified` says Verified", async () => {
        const v = backups([rpRow({sequence: 3, status: "failed", reason: "member_timeout"}), rpRow({sequence: 2}), rpRow({sequence: 1, status: "verified", verifiedAt: "2026-11-07T03:00:00.000Z"})]);
        const {container} = render(<BackupsTab stackId={SID} view={v} runReason={null}/>);
        const rows = screen.getAllByTestId("rp-row");
        expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["failed", "pending_verification", "verified"]);
        expect(within(rows[1]).getByText(RP_STATUS_LABELS.pending_verification.label)).toBeTruthy();
        expect(within(rows[1]).getByTestId("rp-verification").textContent).toBe(BACKUPS.verification.pending_verification);
        expect(within(rows[1]).getByTestId("rp-verification").textContent).not.toMatch(/^Verified/);
        expect(within(rows[2]).getByTestId("rp-verification").textContent).toMatch(/^Verified /);
        expect(within(rows[0]).getByText(BACKUPS.reasons.member_timeout)).toBeTruthy();
        // columns: ID, time + tz, consistency, destinations, size, duration, verification, status
        expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(Object.values(BACKUPS.columns));
        expect(rows[1].textContent).toContain("Europe/Berlin");
        expect(rows[1].textContent).toContain("Offsite S3");
        expect(rows[1].textContent).toContain("5.0 MiB");
        expect(rows[1].textContent).toContain("1 min 35 s");
        expect(container.textContent).not.toMatch(/agent_did|member_timeout|pending_verification/);
        expect(await axeViolations(container)).toEqual([]);
    });

    it("the detail shows artifacts, coverage, warnings and integrity checks — and says verification is NOT available yet", async () => {
        const row = rpRow({sequence: 2, status: "incomplete", reason: "validator_blocked", present: 1});
        const v = backups([row], {row: row as never, artifacts: [art(), art({source: "files", kind: "restic_snapshot", checksum: {recorded: false, short: null}, presence: "unknown", encrypted: false})] as never});
        const {container} = render(<BackupsTab stackId={SID} view={BackupsViewSchema.parse(v)} runReason={null}/>);
        const d = screen.getByTestId("rp-detail");
        expect(d.textContent).toContain(BACKUPS.detail.coverageValue(1, 2));
        expect(d.textContent).toContain(BACKUPS.reasons.validator_blocked);
        expect(d.textContent).toContain("abcdef012345…");
        expect(within(screen.getByTestId("rp-integrity")).getByText(BACKUPS.detail.integrityRows.signature)).toBeTruthy();
        expect(within(screen.getByTestId("rp-integrity")).getByText(BACKUPS.detail.integrityRows.encrypted(false))).toBeTruthy();
        expect(await axeViolations(container)).toEqual([]);
    });

    it("selecting a recovery point is a real link (keyboard reachable) to ?tab=backups&rp=N", () => {
        render(<BackupsTab stackId={SID} view={backups([rpRow({sequence: 7})])} runReason={null}/>);
        const link = screen.getByRole("link", {name: /#7/});
        expect(link.getAttribute("href")).toBe(`/dashboard/stacks/${SID}?tab=backups&rp=7`);
        link.focus();
        expect(document.activeElement).toBe(link);
    });

    it("empty and error states are honest", () => {
        const {rerender} = render(<BackupsTab stackId={SID} view={backups([])} runReason={null}/>);
        expect(screen.getByTestId("backups-none").textContent).toContain(BACKUPS.none.title);
        rerender(<BackupsTab stackId={SID} view={null} runReason={null}/>);
        expect(screen.getByTestId("backups-error")).toBeTruthy();
    });

    it("actions: Back up now is real (the server's answer is shown), Verify / Restore / Mirror are aria-disabled WITH the reason as visible text", async () => {
        start.mockResolvedValue({data: {ok: true, runId: RUN}});
        const {container} = render(<StatusAnnouncer><BackupsTab stackId={SID} view={backups([])} runReason={null}/></StatusAnnouncer>);
        for (const [id, reason] of [["backups-verify", BACKUPS.verify.reason], ["backups-restore", BACKUPS.restore.reason], ["backups-mirror", BACKUPS.mirror.reason]] as const) {
            const b = screen.getByTestId(id);
            expect(b.getAttribute("aria-disabled")).toBe("true");
            expect(b.getAttribute("aria-describedby")).toBeTruthy();
            expect(document.getElementById(b.getAttribute("aria-describedby")!)?.textContent).toBe(reason);
            fireEvent.click(b);
        }
        expect(start).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId("backups-run-now"));
        await waitFor(() => expect(start).toHaveBeenCalledWith({stackId: SID}));
        expect(await axeViolations(container)).toEqual([]);
    });

    it("Back up now with a reason is disabled and does not call the server", () => {
        render(<BackupsTab stackId={SID} view={backups([])} runReason="Configure and activate a backup policy first."/>);
        const b = screen.getByTestId("backups-run-now");
        expect(b.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(b);
        expect(start).not.toHaveBeenCalled();
    });
});

const run = (o: Record<string, unknown> = {}) => ({id: RUN, trigger: "manual", state: "failed", skipReason: null, reason: "agent_did_not_start", validatorBlocked: false, inventoryRefresh: "ok", startedAt: "2026-11-07T02:00:00.000Z", finishedAt: "2026-11-07T02:12:00.000Z",
    steps: [{name: "refresh_inventory", status: "done", attempts: 1, startedAt: null, finishedAt: "2026-11-07T02:00:01.000Z", code: null}, {name: "track", status: "failed", attempts: 40, startedAt: null, finishedAt: null, code: "agent_did_not_start"}],
    items: [{source: "db", dbms: "postgresql", state: "failed", reason: "agent_did_not_start", startedAt: null, finishedAt: null, required: true}, {source: "files", dbms: "files", state: "succeeded", reason: null, startedAt: null, finishedAt: null, required: true}],
    rp: {sequence: 4, status: "failed"}, ...o});
const activity = (runs: Record<string, unknown>[], activeStage: string | null = null): ActivityView => ActivityViewSchema.parse({runs, total: runs.length, activeStage});

describe("Activity tab (durable timeline, sanitised, reload-safe)", () => {
    it("renders stage lines, member items, the plain failure sentence with the configured minutes, the reference id and the not-yet Verify stage; no raw code or free text", async () => {
        const {container} = render(<ActivityTab stackId={SID} view={activity([run()])} limits={LIMITS}/>);
        expect(screen.getByTestId("activity-reason").textContent).toBe("Agent did not start the backup within 10 min");
        const stages = screen.getByTestId("activity-stages");
        expect(within(stages).getByText(ACTIVITY.stage.refresh_inventory)).toBeTruthy();
        expect(within(stages).getByText(ACTIVITY.stage.track)).toBeTruthy();
        expect(stages.querySelector('[data-step="verify"]')?.textContent).toBe(ACTIVITY.verifyStage);
        expect(within(screen.getByTestId("activity-items")).getAllByRole("listitem").map((l) => l.getAttribute("data-state"))).toEqual(["failed", "succeeded"]);
        expect(screen.getByTestId("activity-reference").textContent).toContain(RUN);
        expect(container.textContent).not.toMatch(/agent_did_not_start|member_timeout|postgresql/);
        expect(await axeViolations(container)).toEqual([]);
    });

    it("a reload renders the SAME timeline (everything comes from durable state): two independent renders of the same view are identical", () => {
        const view = activity([run(), run({id: "0b7e1c1e-7f3a-4b6e-9a40-444444444444", state: "succeeded", reason: null, rp: {sequence: 5, status: "pending_verification"}})]);
        const a = render(<ActivityTab stackId={SID} view={view} limits={LIMITS}/>).container.innerHTML;
        cleanup();
        const b = render(<ActivityTab stackId={SID} view={view} limits={LIMITS}/>).container.innerHTML;
        expect(a).toBe(b);
        expect(a).toContain("Backed up · verifying");
    });

    it("a skipped slot and a validator-blocked run say why in plain words", () => {
        render(<ActivityTab stackId={SID} view={activity([run({state: "skipped", skipReason: "overlap", reason: null, steps: [], items: [], rp: null}), run({id: "0b7e1c1e-7f3a-4b6e-9a40-555555555555", state: "incomplete", reason: null, validatorBlocked: true})])} limits={LIMITS}/>);
        expect(screen.getAllByTestId("activity-run")[0].textContent).toContain("Skipped: the previous run was still going.");
        expect(screen.getAllByTestId("activity-run")[1].textContent).toContain("Some required resources were not covered");
    });

    it("empty and error states; the active run is open", () => {
        const {rerender} = render(<ActivityTab stackId={SID} view={activity([])} limits={LIMITS}/>);
        expect(screen.getByTestId("activity-none")).toBeTruthy();
        rerender(<ActivityTab stackId={SID} view={null} limits={LIMITS}/>);
        expect(screen.getByTestId("activity-error")).toBeTruthy();
        rerender(<ActivityTab stackId={SID} view={activity([run({state: "running", reason: null, finishedAt: null, rp: null}), run({id: "0b7e1c1e-7f3a-4b6e-9a40-666666666666"})], "track")} limits={LIMITS}/>);
        const [first, second] = screen.getAllByTestId("activity-run").map((r) => r.querySelector("details")!.open);
        expect([first, second]).toEqual([true, false]);
    });

    it("stage changes between two polls are announced in the ONE role=status region (and nothing is announced on first render)", () => {
        const view = (stage: string | null, state: string) => activity([run({state, reason: null, finishedAt: null, rp: null})], stage);
        const {rerender} = render(<StatusAnnouncer><ActivityTab stackId={SID} view={view("trigger", "running")} limits={LIMITS}/></StatusAnnouncer>);
        const region = screen.getByTestId("job-status");
        expect(region.getAttribute("role")).toBe("status");
        expect(region.textContent).toBe("");
        rerender(<StatusAnnouncer><ActivityTab stackId={SID} view={view("track", "running")} limits={LIMITS}/></StatusAnnouncer>);
        expect(region.textContent).toBe(ACTIVITY.announce(ACTIVITY.stage.track));
        rerender(<StatusAnnouncer><ActivityTab stackId={SID} view={view(null, "succeeded")} limits={LIMITS}/></StatusAnnouncer>);
        expect(region.textContent).toContain("Backup finished");
    });
});

const SP = (primary: ProtectionView["primary"], hours: number | null, verifying = false) => ({
    primary, complete: true, counts: {total: 0, captured: 0, gaps: 0, blockers: 0, warnings: 0, external: 0, excluded: 0, accepted: 0}, recoveryPoints: {verified: 0, pending: 0},
    facets: {lastGoodBackup: {hoursAgo: hours, verifying}, testRestore: {daysAgo: null, stale: false}, deletable: "no", hostCompromise: false, consistency: [], pausedAfterReauthorization: false, inventoryStale: false, configLocked: false},
}) as ProtectionView;

describe("'Last good backup' first line (D43: verified RPs only)", () => {
    it("is the first thing in the header block, counts verified only, and says 'being verified' for a newer pending one", () => {
        const {container} = render(<header><LastGoodBackupLine p={SP("protected", 5, true)}/><span data-testid="badge">badge</span></header>);
        const first = container.querySelector("header")!.firstElementChild!;
        expect(first.getAttribute("data-testid")).not.toBe("badge");
        expect(first.textContent).toContain("5 h ago");
        expect(first.textContent).toContain("being verified");
        cleanup();
        render(<LastGoodBackupLine p={SP("awaiting_first_backup", null)}/>);
        expect(screen.getByText(/No verified backup yet/)).toBeTruthy();
    });
});

const strip = (items: SafetyStrip["items"], agentIssues: SafetyStrip["agentIssues"] = [], o: Partial<SafetyStrip> = {}): SafetyStrip => SafetyStripSchema.parse({
    counts: {safe: items.filter((i) => i.bucket === "safe").length, needsAttention: items.filter((i) => i.bucket === "needs_attention").length, notProtected: items.filter((i) => i.bucket === "not_protected").length},
    items, agentIssues, capped: false, total: items.length, ...o,
});

describe("'Am I safe?' strip", () => {
    it("three groups with counts; every item has plain reasons and a fix link (EU-15)", async () => {
        const s = strip([
            {stackId: SID, name: "shop", bucket: "needs_attention", reasons: ["failed", "paused"]},
            {stackId: SID2, name: "blog", bucket: "not_protected", reasons: ["unprotected"]},
        ]);
        const {container} = render(<SafetyStripView strip={s}/>);
        expect(screen.getByTestId("strip-count-safe").textContent).toBe("0");
        expect(screen.getByTestId("strip-count-needs_attention").textContent).toBe("1");
        expect(screen.getByTestId("strip-count-not_protected").textContent).toBe("1");
        expect(within(screen.getByTestId("strip-safe")).getByText(STRIP.buckets.safe.empty)).toBeTruthy();
        const attention = screen.getByTestId("strip-needs_attention");
        expect(within(attention).getByText(STRIP.reasons.failed.label)).toBeTruthy();
        expect(within(attention).getByRole("link", {name: STRIP.reasons.failed.fix}).getAttribute("href")).toBe(`/dashboard/stacks/${SID}?tab=activity`);
        expect(within(attention).getByRole("link", {name: STRIP.reasons.paused.fix}).getAttribute("href")).toBe(`/dashboard/stacks/${SID}/configure`);
        expect(within(screen.getByTestId("strip-not_protected")).getByRole("link", {name: STRIP.reasons.unprotected.fix}).getAttribute("href")).toBe(`/dashboard/stacks/${SID2}/configure`);
        expect(container.textContent).not.toMatch(/agent_poll_failing|needs_attention|not_protected|host_compromise/);
        expect(await axeViolations(container)).toEqual([]);
    });

    it("'Agent poll failing: <agent>' is ONE item listing the affected stacks, never repeated under every stack", () => {
        const s = strip([
            {stackId: SID, name: "shop", bucket: "needs_attention", reasons: ["agent_poll_failing"]},
            {stackId: SID2, name: "blog", bucket: "needs_attention", reasons: ["partial", "agent_poll_failing"]},
        ], [{agentName: "host-1", stacks: [{id: SID2, name: "blog"}, {id: SID, name: "shop"}]}]);
        render(<SafetyStripView strip={s}/>);
        expect(screen.getAllByTestId("strip-agent-issue")).toHaveLength(1);
        expect(screen.getByTestId("strip-agent-issue").textContent).toContain(STRIP.agentIssue("host-1"));
        expect(screen.getByTestId("strip-agent-issue").textContent).toContain(STRIP.agentIssueBody(2));
        expect(screen.queryAllByText(STRIP.reasons.agent_poll_failing.label)).toHaveLength(0); // not duplicated per stack
        expect(screen.getByTestId("strip-count-needs_attention").textContent).toBe("2");
    });

    it("an honest note when no notification channel is configured, and the cap is shown", () => {
        render(<SafetyStripView strip={strip([], [], {capped: true, total: 450})} noChannel/>);
        expect(screen.getByTestId("strip-no-channel").textContent).toContain(STRIP.noChannel.title);
        expect(screen.getByTestId("strip-capped").textContent).toBe(STRIP.capped(0, 450));
    });

    it("nothing can read Safe unless the mapping said safe", () => {
        render(<SafetyStripView strip={strip([{stackId: SID, name: "shop", bucket: "needs_attention", reasons: ["kit_not_verified"]}])}/>);
        expect(within(screen.getByTestId("strip-safe")).queryByText("shop")).toBeNull();
        expect(within(screen.getByTestId("strip-needs_attention")).getByText("shop")).toBeTruthy();
    });
});

const POLICY = {schedule: {preset: "daily", timezone: "UTC", minute: 0, hour: 2, weekday: 0, monthday: 1} as never, retention: {keep_last: 3, daily: 7, weekly: 4, monthly: 6, yearly: 0}};

describe("Schedule editor (system admin only, locked with a visible reason)", () => {
    it("a member or a locked configuration gets an aria-disabled button with the reason as text, and no form", () => {
        const {rerender} = render(<ScheduleEditor stackId={SID} {...POLICY} reason={SCHEDULE_EDIT.reasons.member}/>);
        let b = screen.getByTestId("schedule-edit-open");
        expect(b.getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(b.getAttribute("aria-describedby")!)?.textContent).toBe(SCHEDULE_EDIT.reasons.member);
        fireEvent.click(b);
        expect(screen.queryByTestId("schedule-edit-form")).toBeNull();
        rerender(<ScheduleEditor stackId={SID} {...POLICY} reason={SCHEDULE_EDIT.reasons.locked}/>);
        b = screen.getByTestId("schedule-edit-open");
        expect(document.getElementById(b.getAttribute("aria-describedby")!)?.textContent).toBe(SCHEDULE_EDIT.reasons.locked);
    });

    it("an administrator edits, saves through the server action and sees the SERVER's verdict (keyboard operable, axe clean)", async () => {
        update.mockResolvedValue({data: {ok: true, cron: "0 3 * * *", nextRuns: [], noop: false, paused: false}});
        const {container} = render(<StatusAnnouncer><ScheduleEditor stackId={SID} {...POLICY} reason={null}/></StatusAnnouncer>);
        const open = screen.getByTestId("schedule-edit-open");
        open.focus();
        expect(document.activeElement).toBe(open); // a native, focusable button
        fireEvent.click(open); // (Enter/Space on a native button is a click)
        const form = await screen.findByTestId("schedule-edit-form");
        expect(await axeViolations(container)).toEqual([]);
        // every control in the form is a native, tabbable element
        for (const el of form.querySelectorAll("input, select, button, summary")) expect((el as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
        const keep = within(form).getByLabelText(/newest/i, {selector: "input"}) as HTMLInputElement;
        fireEvent.change(keep, {target: {value: "9"}});
        fireEvent.submit(form); // Enter inside a field submits the form
        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        const arg = update.mock.calls[0][0] as {stackId: string; retention: {keep_last: number}; schedule: {preset: string}};
        expect(arg.stackId).toBe(SID);
        expect(arg.retention.keep_last).toBe(9);
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toBe(SCHEDULE_EDIT.saved));
        expect(refresh).toHaveBeenCalled();
    });

    it("a refusal is shown as the server said it; nothing is claimed saved", async () => {
        update.mockResolvedValue({data: {ok: false, code: "locked", message: "Fork configuration is locked (self-check-failed); fix the cause first."}});
        render(<StatusAnnouncer><ScheduleEditor stackId={SID} {...POLICY} reason={null}/></StatusAnnouncer>);
        fireEvent.click(screen.getByTestId("schedule-edit-open"));
        fireEvent.click(screen.getByTestId("schedule-edit-save"));
        await waitFor(() => expect(screen.getByTestId("schedule-edit-error").textContent).toBe(SCHEDULE_EDIT.outcome.locked));
        expect(screen.getByTestId("job-status").textContent).toBe(SCHEDULE_EDIT.outcome.locked);
        expect(refresh).not.toHaveBeenCalled();
        expect(screen.getByTestId("schedule-edit-form")).toBeTruthy(); // the form stays open
    });

    it("invalid retention blocks Save client-side (the server re-validates anyway)", async () => {
        render(<ScheduleEditor stackId={SID} {...POLICY} reason={null}/>);
        fireEvent.click(screen.getByTestId("schedule-edit-open"));
        const keep = screen.getByLabelText(/newest/i, {selector: "input"}) as HTMLInputElement;
        fireEvent.change(keep, {target: {value: "0"}});
        fireEvent.click(screen.getByTestId("schedule-edit-save"));
        expect(update).not.toHaveBeenCalled();
        expect(screen.getByRole("alert").textContent).toBe(SCHEDULE_EDIT.outcome.invalid_input);
    });
});
