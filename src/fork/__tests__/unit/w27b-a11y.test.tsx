// @vitest-environment jsdom
// W27b WCAG 2.2 AA fixes D-01..D-08 (plan-W27b §5.1). No clock is read against a fixed timestamp.
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import * as React from "react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {STACK_ID, w11View} from "@/fork/__tests__/w11-fixtures";
import {KIT_NONE, type KitView} from "@/fork/kit/service";
import {RetentionPolicySchema, DEFAULT_RETENTION} from "@/fork/recovery/retention-policy";
import {parseStackListParams} from "@/fork/stacks/params";
import type {TestRestoreView} from "@/fork/test-restore/view";
import {DEFAULT_TR_SCHEDULE} from "@/fork/test-restore/vocab";

const refresh = vi.fn();
const start = vi.fn();
const update = vi.fn();
const setPrivacy = vi.fn();
vi.mock("next/navigation", () => ({useRouter: () => ({refresh}), notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));
vi.mock("@/fork/actions/stack-run.action", () => ({startStackRunAction: (...a: unknown[]) => start(...a), cancelStackRunAction: vi.fn()}));
vi.mock("@/fork/actions/stack-schedule.action", () => ({updateStackScheduleAction: (...a: unknown[]) => update(...a)}));
vi.mock("@/fork/actions/stack-quiesce.action", () => ({previewQuiesceAction: vi.fn(), enableQuiesceAction: vi.fn(), disableQuiesceAction: vi.fn(), startQuiesceNowAction: vi.fn()}));
vi.mock("@/fork/actions/test-restore.action", () => ({setTestRestoreScheduleAction: vi.fn(), runTestRestoreNowAction: vi.fn(), wipeTestRestoreNowAction: vi.fn()}));
vi.mock("@/fork/actions/restore-plan.action", () => ({setStackPrivacyAction: (...a: unknown[]) => setPrivacy(...a)}));
vi.mock("@/fork/actions/stack-policy.action", () => ({activateStackPolicyAction: vi.fn(), previewStackPolicyAction: vi.fn()}));
vi.mock("@/fork/actions/kit.action", () => ({beginKitGenerationAction: vi.fn(), confirmKitFingerprintAction: vi.fn(), rotateKekAction: vi.fn()}));
vi.mock("@/fork/actions/dashboard-db.action", () => ({declareDashboardDbSourceAction: vi.fn()}));

import {A11Y_COPY} from "@/fork/ui/a11y/labels";
import {retentionFieldErrors} from "@/fork/ui/a11y/retention-errors";
import {CONFIGURE, RUNS, SCHEDULE_EDIT} from "@/fork/ui/labels";
import {KitPanel} from "@/fork/ui/kit/kit-panel.client";
import {DashboardDbCard, KekCard} from "@/fork/ui/kit/kit-extras.client";
import {SecretInput, type SecretHandle} from "@/fork/ui/secret-input";
import {RunNowButton} from "@/fork/ui/stacks/run-controls.client";
import {ScheduleEditor} from "@/fork/ui/stacks/schedule/schedule-edit.client";
import {ScheduleTab} from "@/fork/ui/stacks/schedule/schedule-tab";
import {StackFilters} from "@/fork/ui/stacks/stack-filters";
import {StacksEmpty} from "@/fork/ui/stacks/stack-empty-states";
import {TestRestorePoller} from "@/fork/ui/stacks/test-restore/test-restore-edit.client";
import {TestRestorePanel} from "@/fork/ui/stacks/test-restore/test-restore-panel";
import {TR} from "@/fork/ui/stacks/test-restore/labels";
import {ConfigureForm} from "@/fork/ui/stacks/wizard/configure-form.client";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const AA = "bg-[#c2410c]";
const SID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const AGENT = "0b7e1c1e-7f3a-4b6e-9a40-222222222222";
const POLICY = {schedule: {preset: "daily", timezone: "UTC", minute: 0, hour: 2, weekday: 0, monthday: 1} as never, retention: {keep_last: 3, daily: 7, weekly: 4, monthly: 6, yearly: 0}};
const mountForm = (locked = false) => {
    const qc = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    return render(<QueryClientProvider client={qc}><StatusAnnouncer><ConfigureForm view={w11View({db: true})} locked={locked}/></StatusAnnouncer></QueryClientProvider>);
};
type Last = NonNullable<TestRestoreView["last"]>;
const last = (o: Partial<Last> = {}): Last => ({runId: "0b7e1c1e-7f3a-4b6e-9a40-333333333333", state: "succeeded", reason: null, trigger: "manual", startedAt: new Date(Date.now() - 600_000).toISOString(), finishedAt: new Date(Date.now() - 300_000).toISOString(),
    durationSeconds: 125, integrity: {checked: 2, failed: 0, notSupported: 1}, wipe: {state: "verified", reason: null, finishedAt: new Date(Date.now() - 200_000).toISOString()}, ...o});
const trView = (o: Partial<TestRestoreView> = {}): TestRestoreView => ({
    schedule: {configured: true, enabled: true, preset: "weekly", timezone: "UTC", cron: "30 3 * * 0", nextRuns: [new Date(Date.now() + 86_400_000).toISOString()], targetAgentName: "lab-test", staleAfterDays: 14, paused: null},
    privacy: {containsPersonalData: true, optIn: false}, facet: {daysAgo: 0, stale: false}, last: last(),
    admin: {restoreRoot: "/srv/restore", candidates: [{id: AGENT, name: "lab-test"}], schedule: {...DEFAULT_TR_SCHEDULE}, targetAgentId: AGENT},
    can: {configure: true, runNow: true, wipeNow: true}, ...o,
} as TestRestoreView);

beforeEach(() => { for (const f of [refresh, start, update, setPrivacy]) f.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("T-D01 fork-rendered primary actions use the AA colour", () => {
    it("stack filters submit, admin empty-state link, schedule-tab link, schedule save, kit create, dashboard-DB save", async () => {
        const f = render(<StackFilters params={parseStackListParams({})} environments={[]}/>);
        const apply = f.container.querySelector("button[type=submit]")!;
        expect(apply.className).toContain(AA);
        expect(apply.className).not.toContain("bg-primary");
        expect(await axeViolations(f.container)).toEqual([]);
        cleanup();
        const e = render(<StacksEmpty kind="noConnection" isAdmin/>);
        const link = e.container.querySelector("a")!;
        expect(link.className).toContain(AA);
        expect(link.className).not.toContain("bg-primary");
        expect(await axeViolations(e.container)).toEqual([]);
        cleanup();
        const t = render(<ScheduleTab policy={null} stackId={STACK_ID} canConfigure configureHref="/x"/>);
        expect(screen.getByRole("link", {name: /configure/i}).className).toContain(AA);
        expect(await axeViolations(t.container)).toEqual([]);
        cleanup();
        render(<StatusAnnouncer><ScheduleEditor stackId={SID} {...POLICY} reason={null}/></StatusAnnouncer>);
        fireEvent.click(screen.getByTestId("schedule-edit-open"));
        expect(screen.getByTestId("schedule-edit-save").className).toContain(AA);
        cleanup();
        const k = render(<KitPanel view={{...KIT_NONE} as KitView} canManage lockedReason={null}/>);
        for (const b of k.container.querySelectorAll("form button[type=submit]")) { expect(b.className).toContain(AA); expect(b.className).not.toContain("bg-primary"); }
        expect(await axeViolations(k.container)).toEqual([]);
        cleanup();
        const d = render(<DashboardDbCard view={{verdict: "not_declared", sourceName: null, hasSchedule: false, lastSuccessAt: null, channels: []} as never} candidates={[]} disabled={false}/>);
        expect(d.container.querySelector("form button[type=submit]")!.className).toContain(AA);
    });
});

describe("T-D02 one live region per page", () => {
    it("run-now outcome stays visible but is not its own role=status; the page has exactly one", async () => {
        start.mockResolvedValue({data: {ok: true, runId: "r1"}});
        render(<StatusAnnouncer><RunNowButton stackId={SID} label="Back up now" reason={null}/></StatusAnnouncer>);
        fireEvent.click(screen.getByTestId("run-now"));
        await waitFor(() => expect(screen.getByTestId("run-now-outcome").textContent).toBe(RUNS.action.outcome.started));
        expect(screen.getByTestId("run-now-outcome").getAttribute("role")).toBeNull();
        expect(screen.getAllByRole("status")).toHaveLength(1);
        expect(screen.getByTestId("job-status").textContent).toBe(RUNS.action.outcome.started);
    });
    it("schedule save outcome (ok) and the test-restore privacy outcome are not role=status either", async () => {
        update.mockResolvedValue({data: {ok: true, cron: "0 3 * * *", nextRuns: [], noop: false, paused: false}});
        render(<StatusAnnouncer><ScheduleEditor stackId={SID} {...POLICY} reason={null}/></StatusAnnouncer>);
        fireEvent.click(screen.getByTestId("schedule-edit-open"));
        fireEvent.submit(screen.getByTestId("schedule-edit-form"));
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toBe(SCHEDULE_EDIT.saved));
        expect(screen.getAllByRole("status")).toHaveLength(1);
        cleanup();
        setPrivacy.mockResolvedValueOnce({data: {ok: true}});
        render(<StatusAnnouncer><TestRestorePanel view={trView()} stackId={SID} isAdmin configLocked={false}/></StatusAnnouncer>);
        fireEvent.click(screen.getByTestId("tr-privacy-save"));
        await waitFor(() => expect(screen.getByTestId("tr-privacy-outcome")).toBeTruthy());
        expect(screen.getByTestId("tr-privacy-outcome").getAttribute("role")).toBeNull();
        expect(screen.getAllByRole("status")).toHaveLength(1);
        expect(screen.getByTestId("job-status").textContent).toBe(TR.privacy.saved);
    });
});

describe("T-D03 a result discovered by polling is announced once", () => {
    it("active -> idle announces the headline; first render, unchanged rerender and idle -> idle announce nothing", () => {
        vi.useFakeTimers();
        const {rerender} = render(<StatusAnnouncer><TestRestorePoller active={false} headline="Idle headline"/></StatusAnnouncer>);
        expect(screen.getByTestId("job-status").textContent).toBe("");
        rerender(<StatusAnnouncer><TestRestorePoller active headline="Test restore is running"/></StatusAnnouncer>);
        expect(screen.getByTestId("job-status").textContent).toBe("");
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(refresh).toHaveBeenCalledTimes(1);
        rerender(<StatusAnnouncer><TestRestorePoller active={false} headline="Test restore finished: passed"/></StatusAnnouncer>);
        expect(screen.getByTestId("job-status").textContent).toBe("Test restore finished: passed");
        const n = refresh.mock.calls.length;
        act(() => { vi.advanceTimersByTime(30_000); });
        expect(refresh).toHaveBeenCalledTimes(n); // stopped polling
        rerender(<StatusAnnouncer><TestRestorePoller active={false} headline="Something else"/></StatusAnnouncer>);
        expect(screen.getByTestId("job-status").textContent).toBe("Test restore finished: passed");
    });
    it("no headline, no announcement", () => {
        const {rerender} = render(<StatusAnnouncer><TestRestorePoller active headline={null}/></StatusAnnouncer>);
        rerender(<StatusAnnouncer><TestRestorePoller active={false} headline={null}/></StatusAnnouncer>);
        expect(screen.getByTestId("job-status").textContent).toBe("");
    });
});

describe("T-D04 field-level retention errors", () => {
    const lbl = (k: string) => `L-${k}`;
    it("retentionFieldErrors names the field and the schema bounds", () => {
        expect(retentionFieldErrors(DEFAULT_RETENTION, lbl)).toEqual({});
        expect(retentionFieldErrors({...DEFAULT_RETENTION, keep_last: 0}, lbl).keep_last).toBe(A11Y_COPY.retentionRange("L-keep_last", 1, 100));
        expect(retentionFieldErrors({...DEFAULT_RETENTION, keep_last: 0}, lbl).keep_last).toContain("from 1 to 100");
        expect(retentionFieldErrors({...DEFAULT_RETENTION, daily: 367}, lbl).daily).toContain("from 0 to 366");
        expect(Object.keys(retentionFieldErrors({...DEFAULT_RETENTION, weekly: Number.NaN}, lbl))).toEqual(["weekly"]);
        expect(Object.keys(retentionFieldErrors({...DEFAULT_RETENTION, monthly: "abc"}, lbl))).toEqual(["monthly"]);
    });
    it("bounds read from the schema equal its real behaviour (pin for the zod read path)", () => {
        for (const k of Object.keys(RetentionPolicySchema.shape) as (keyof typeof RetentionPolicySchema.shape)[]) {
            const s = RetentionPolicySchema.shape[k];
            const errs = retentionFieldErrors({...DEFAULT_RETENTION, [k]: (s.minValue as number) - 1}, lbl);
            expect(errs[k], k).toBe(A11Y_COPY.retentionRange(lbl(k), s.minValue as number, s.maxValue as number));
            expect(s.safeParse(s.minValue).success && s.safeParse(s.maxValue).success && !s.safeParse((s.maxValue as number) + 1).success, k).toBe(true);
        }
    });
    it("schedule editor: keep-last 0 marks only that input invalid and links a field-named message", async () => {
        const {container} = render(<ScheduleEditor stackId={SID} {...POLICY} reason={null}/>);
        fireEvent.click(screen.getByTestId("schedule-edit-open"));
        const keep = container.querySelector("#edit-ret-keep_last") as HTMLInputElement;
        fireEvent.change(keep, {target: {value: "0"}});
        expect(keep.getAttribute("aria-invalid")).toBe("true");
        const desc = keep.getAttribute("aria-describedby")!.split(" ");
        expect(desc).toContain("edit-ret-keep_last-err");
        expect(document.getElementById("edit-ret-keep_last-err")!.textContent).toBe(A11Y_COPY.retentionRange(CONFIGURE.schedule.retention.keep_last, 1, 100));
        expect(container.querySelector("#edit-ret-daily")!.hasAttribute("aria-invalid")).toBe(false);
        expect(await axeViolations(container)).toEqual([]);
        fireEvent.change(keep, {target: {value: "3"}});
        expect(keep.hasAttribute("aria-invalid")).toBe(false);
        expect(document.getElementById("edit-ret-keep_last-err")).toBeNull();
    });
    it("configure form: same contract", async () => {
        const {container} = mountForm();
        const keep = container.querySelector("#ret-keep_last") as HTMLInputElement;
        fireEvent.change(keep, {target: {value: "0"}});
        expect(keep.getAttribute("aria-invalid")).toBe("true");
        expect(keep.getAttribute("aria-describedby")).toContain("ret-keep_last-err");
        expect(document.getElementById("ret-keep_last-err")!.textContent).toContain("from 1 to 100");
        expect(container.querySelector("#ret-daily")!.hasAttribute("aria-invalid")).toBe(false);
        expect(within(container).getAllByRole("alert").length).toBeGreaterThan(0); // group-level line kept
    }, 30_000);
});

describe("T-D06 input purpose on account-password fields only", () => {
    const H = React.createRef<SecretHandle>();
    it("default SecretInput stays suppressed (secret-default guard); purpose switches the password-manager attributes and keeps take() clearing", () => {
        const {container} = render(<div><SecretInput ref={H} label="A secret" name="a"/><SecretInput label="Account password" name="b" purpose="current-password"/></div>);
        const [plain, acct] = Array.from(container.querySelectorAll("input"));
        expect(plain.getAttribute("autocomplete")).toBe("off");
        for (const a of ["data-1p-ignore", "data-lpignore", "data-form-type"]) expect(plain.hasAttribute(a), a).toBe(true);
        expect(acct.getAttribute("autocomplete")).toBe("current-password");
        for (const a of ["data-1p-ignore", "data-lpignore", "data-form-type"]) expect(acct.hasAttribute(a), a).toBe(false);
        expect(acct.type).toBe("password");
        plain.value = "s3cret";
        expect(H.current!.take()).toBe("s3cret");
        expect(plain.value).toBe("");
    });
    it("kit create password and KEK rotation current-password", () => {
        const {container} = render(<KitPanel view={{...KIT_NONE} as KitView} canManage lockedReason={null}/>);
        const pw = container.querySelector("input[name=kit-password]") as HTMLInputElement;
        expect(pw.getAttribute("autocomplete")).toBe("current-password");
        expect(pw.hasAttribute("data-1p-ignore")).toBe(false);
        // the two passphrases are rendered only after a grant: their SecretInputs carry no `purpose` (checked in the static guard)
        cleanup();
        const k = render(<KekCard disabled={false}/>);
        expect((k.container.querySelector("input[name=kek-password]") as HTMLInputElement).getAttribute("autocomplete")).toBe("current-password");
    });
});

describe("T-D08 opt-in checkbox announces the confirmation in advance", () => {
    it("describedby resolves to the hint; the blocked variant adds the reason", async () => {
        const a = render(<StatusAnnouncer><TestRestorePanel view={trView()} stackId={SID} isAdmin configLocked={false}/></StatusAnnouncer>);
        const box = screen.getByTestId("tr-optin");
        const text = (el: HTMLElement) => el.getAttribute("aria-describedby")!.split(" ").map((i) => document.getElementById(i)?.textContent).join(" | ");
        expect(text(box)).toContain(A11Y_COPY.optInConfirmHint);
        expect(await axeViolations(a.container)).toEqual([]);
        cleanup();
        render(<StatusAnnouncer><TestRestorePanel view={trView()} stackId={SID} isAdmin={false} configLocked={false}/></StatusAnnouncer>);
        const blocked = screen.getByTestId("tr-optin");
        expect(text(blocked)).toContain(A11Y_COPY.optInConfirmHint);
        expect(text(blocked)).toContain(TR.reasons.privacy);
    });
});
