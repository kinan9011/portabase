// @vitest-environment jsdom
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {act, cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {CH_S3, STACK_ID, w11Inventory, w11View} from "@/fork/__tests__/w11-fixtures";
import {computePreview} from "@/fork/stack-policy/preview";
import {SelectionSchema} from "@/fork/materialize/types";
import {CONFIGURE, SCHEDULE_TAB} from "@/fork/ui/labels";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({useRouter: () => ({refresh}), notFound: () => { throw new Error("NEXT_NOT_FOUND"); }}));
const activateAction = vi.fn();
const previewAction = vi.fn();
vi.mock("@/fork/actions/stack-policy.action", () => ({activateStackPolicyAction: (...a: unknown[]) => activateAction(...a), previewStackPolicyAction: (...a: unknown[]) => previewAction(...a)}));

import {ConfigureForm} from "@/fork/ui/stacks/wizard/configure-form.client";
import {ScheduleTab} from "@/fork/ui/stacks/schedule-tab";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";
import type {ConfigureView} from "@/fork/stack-policy/configure-view";

const T = CONFIGURE;
const mount = (view: ConfigureView, locked = false) => {
    const qc = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    return render(<QueryClientProvider client={qc}><StatusAnnouncer><ConfigureForm view={view} locked={locked}/></StatusAnnouncer></QueryClientProvider>);
};
const PW = "Pw-ui-canary-77";
const okActivate = {data: {ok: true, planHash: "x", created: 2, updated: 0, unchanged: 0, orphaned: 0, deferred: [], skipped: [], sources: [{key: "dir:/srv/app", role: "compose", name: "compose", status: "active"}, {key: "mount:m", role: "bind", name: "bind", status: "active"}], noop: false, activatedAt: "2026-11-07T10:00:00.000Z", cron: "0 2 * * *", nextRuns: ["2026-11-08T02:00:00.000Z"]}};

beforeEach(() => {
    refresh.mockReset(); activateAction.mockReset(); previewAction.mockReset();
    previewAction.mockImplementation(async (i: {selection: unknown; acceptedExclusions: string[]}) => ({data: {ok: true, preview: computePreview(w11Inventory(), SelectionSchema.parse(i.selection), i.acceptedExclusions, [])}}));
});
afterEach(cleanup);
const pickChannel = (name: RegExp) => fireEvent.click(screen.getByRole("checkbox", {name}));

describe("W11 form structure (single page, five sections)", () => {
    it("renders the five sections in order as landmarks with headings; no stop/quiesce control exists (D29); axe clean", async () => {
        const {container} = mount(w11View({db: true}));
        const heads = ["resources", "consistency", "schedule", "storage", "review"].map((s) => screen.getByTestId(`section-${s}`));
        for (const [i, h] of heads.entries()) { expect(h.tagName).toBe("SECTION"); if (i > 0) expect(heads[i - 1].compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); }
        expect(screen.getAllByRole("heading", {level: 2}).map((h) => h.textContent)).toEqual(Object.values(T.sections));
        expect(container.textContent).not.toMatch(/stop \+ copy|quiesce|pause the container/i);
        expect(container.querySelector("[name*=stop i], [id*=stop i], [value=stop]")).toBeNull();
        expect(container.querySelector("[title]")).toBeNull();
        expect(await axeViolations(container)).toEqual([]);
    }, 30_000); // axe over the whole form takes ~3 s locally, > 5 s on a CI runner

    it("every interactive control is natively focusable (no positive tabindex); aria-disabled buttons stay focusable with a visible reason", () => {
        const {container} = mount(w11View());
        for (const el of container.querySelectorAll("[tabindex]")) expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
        const activate = screen.getByTestId("activate");
        expect(activate.getAttribute("aria-disabled")).toBe("true");
        expect(activate.hasAttribute("disabled")).toBe(false);
        const why = document.getElementById(activate.getAttribute("aria-describedby")!)!;
        expect(why.textContent).toBe(T.review.blockers.no_channel_selected);
        const run = screen.getByTestId("run-first");
        expect(run.getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(run.getAttribute("aria-describedby")!)!.textContent).toBe(T.review.runFirstReason);
    });
});

describe("W11 Resources (UX-20, D18, D19, SEC-24)", () => {
    it("lists items with their plan verdict and Required/Optional; the compose folder toggle covers compose + env files", () => {
        mount(w11View());
        const rows = screen.getAllByTestId("resource-row");
        expect(rows.some((r) => r.getAttribute("data-key") === "volume:app_data" && r.getAttribute("data-plan") === "backed_up")).toBe(true);
        expect(screen.getByTestId("compose-folder-row").textContent).toContain("/srv/app");
        expect(screen.getAllByText(T.resources.roleRequired).length).toBeGreaterThan(0);
    });

    it("excluding a required volume asks the server for a preview, shows the non-recoverable notice and an accept checkbox; accepting sends the key", async () => {
        mount(w11View());
        fireEvent.click(screen.getByRole("checkbox", {name: T.resources.include("app_data")}));
        await waitFor(() => expect(previewAction).toHaveBeenCalledWith(expect.objectContaining({stackId: STACK_ID, selection: expect.objectContaining({excludeKeys: ["volume:app_data"]})})));
        const gap = await screen.findByTestId("gap-notice");
        expect(gap.textContent).toContain(T.resources.notRecoverable);
        fireEvent.click(within(gap).getByRole("checkbox", {name: T.resources.accept("app_data")}));
        await waitFor(() => expect(previewAction).toHaveBeenLastCalledWith(expect.objectContaining({acceptedExclusions: ["volume:app_data"]})));
        await waitFor(() => expect(screen.getByTestId("review-gaps").textContent).toBe(T.review.complete));
    });

    it("SEC-24: add-volume error is shown AT THE FIELD in plain words (path-like, anonymous, unknown, already added) and nothing is added", () => {
        mount(w11View());
        const input = screen.getByLabelText(T.resources.volume.name);
        const add = screen.getByRole("button", {name: T.resources.volume.add});
        for (const [value, text] of [["/tmp/x", T.fieldErrors.volume_name_path_like], ["../etc", T.fieldErrors.volume_name_path_like], ["f".repeat(64), T.fieldErrors.volume_name_anonymous], ["ghost", T.fieldErrors.volume_not_in_inventory]] as const) {
            fireEvent.change(input, {target: {value}});
            fireEvent.click(add);
            const err = screen.getByTestId("volume-error");
            expect(err.textContent).toBe(text);
            expect(err.getAttribute("role")).toBe("alert");
            expect(input.getAttribute("aria-invalid")).toBe("true");
            expect(input.getAttribute("aria-describedby")).toContain(err.id);
        }
        fireEvent.change(input, {target: {value: "app_data"}});
        fireEvent.click(add);
        expect(screen.getByTestId("volume-error").textContent).toBe(T.resources.volume.already);
        expect(screen.queryByText(T.resources.volume.added("ghost"))).toBeNull();
        // a volume that was left out can be put back by name
        fireEvent.click(screen.getByRole("checkbox", {name: T.resources.include("app_data")}));
        fireEvent.click(add);
        expect(screen.queryByTestId("volume-error")).toBeNull();
        expect(screen.getByText(T.resources.volume.added("app_data"))).toBeTruthy();
        expect((screen.getByRole("checkbox", {name: T.resources.include("app_data")}) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    });

    it("manual source (D19): disabled with a visible reason while no allowed roots are configured", () => {
        mount(w11View({roots: false}));
        const btn = within(screen.getByTestId("manual-sources")).getByRole("button", {name: T.resources.manual.add});
        expect(btn.getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(btn.getAttribute("aria-describedby")!)!.textContent).toBe(T.resources.manual.noRoots);
    });
});

describe("W11 Consistency (D29)", () => {
    it("a stop label gets the explicit 'not available until R2' message and NO control; DB files mode warns it stays Partial", () => {
        previewAction.mockImplementation(async () => ({data: {ok: true, preview: computePreview(w11Inventory({db: true, stop: true}), SelectionSchema.parse({}), [], [])}}));
        const view = w11View({db: true, stop: true});
        mount(view);
        const note = screen.getByTestId("stop-label-note");
        expect(note.textContent).toContain("not available until release R2");
        expect(note.textContent).toContain("web");
        fireEvent.click(within(screen.getByTestId("db-block")).getByRole("radio", {name: T.consistency.files}));
        expect(within(screen.getByTestId("db-block")).getByRole("note").textContent).toBe(T.consistency.filesWarning);
    });
    it("dump mode: connection fields + a write-only password input with the §8.2 attributes", () => {
        mount(w11View({db: true}));
        const pw = screen.getByLabelText(new RegExp(T.consistency.fields.password)) as HTMLInputElement;
        expect(pw.type).toBe("password");
        expect(pw.getAttribute("autocomplete")).toBe("off");
        expect(pw.getAttribute("spellcheck")).toBe("false");
        expect(pw.getAttribute("data-gramm")).toBe("false");
        expect(pw.hasAttribute("data-1p-ignore")).toBe(true);
        expect(pw.value).toBe("");
        expect(screen.getByText(T.consistency.hostHint)).toBeTruthy();
    });
});

describe("W11 Schedule (EU-16)", () => {
    it("presets + timezone; raw cron exists only inside the Advanced disclosure; next three runs shown; invalid cron is explained and blocks", async () => {
        mount(w11View());
        const adv = screen.getByTestId("schedule-advanced");
        expect(adv.tagName).toBe("DETAILS");
        expect(adv.contains(screen.getByLabelText(T.schedule.cron))).toBe(true);
        expect(screen.getAllByLabelText(T.schedule.cron)).toHaveLength(1);
        expect(within(screen.getByTestId("next-runs")).getAllByRole("listitem")).toHaveLength(3);
        fireEvent.change(screen.getByLabelText(T.schedule.preset), {target: {value: "weekly"}});
        expect(screen.getByLabelText(T.schedule.weekday)).toBeTruthy();
        fireEvent.change(screen.getByLabelText(T.schedule.cron), {target: {value: "61 0 * * *"}});
        expect((await screen.findByRole("alert")).textContent).toBe(T.schedule.cronInvalid);
        expect(screen.getByTestId("activate").getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(screen.getByTestId("activate").getAttribute("aria-describedby")!)!.textContent).toBe(T.review.blockers.no_channel_selected);
    });
});

describe("W11 Storage (§4.5, EU-08)", () => {
    it("`local`-only is blocked inline AND on the button; facets read 'not checked'; size unknown without reported sizes", () => {
        mount(w11View());
        pickChannel(/dashboard-local/);
        expect(screen.getByTestId("channel-rule").textContent).toBe(T.storage.rule.local_only_channels);
        const activate = screen.getByTestId("activate");
        expect(activate.getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(activate.getAttribute("aria-describedby")!)!.textContent).toBe(T.review.blockers.local_only_channels);
        expect(screen.getAllByText(`${T.storage.deletable.label}: ${T.storage.deletable.not_checked}`)).toHaveLength(2);
        expect(screen.getByText(T.storage.local)).toBeTruthy();
        expect(screen.getByTestId("size-estimate").textContent).toContain(T.storage.size.unknown);
        pickChannel(/offsite/);
        expect(screen.queryByTestId("channel-rule")).toBeNull();
        expect(document.getElementById(activate.getAttribute("aria-describedby") ?? "x")).toBeNull(); // enabled: no blocking reason
        expect(activate.getAttribute("aria-disabled")).toBeNull();
    });
    it("steady-state estimate only from Arcane-reported sizes, with its caveat", () => {
        mount(w11View({db: true}));
        expect(screen.getByTestId("size-estimate").textContent).toMatch(/About 2\.0 GiB for one full copy of 1 volume.*before compression and deduplication/);
    });
    it("encryption off (D39) is explained and blocks activation", () => {
        mount(w11View({encryption: false}));
        expect(screen.getByTestId("encryption-off").textContent).toBe(T.storage.encryptionOff);
        pickChannel(/offsite/);
        expect(document.getElementById(screen.getByTestId("activate").getAttribute("aria-describedby")!)!.textContent).toBe(T.review.blockers.encryption_off);
    });
    it("a locked configuration (D21) blocks activation with its reason", () => {
        mount(w11View(), true);
        pickChannel(/offsite/);
        expect(screen.getByTestId("configure-locked").textContent).toBe(T.locked);
        expect(document.getElementById(screen.getByTestId("activate").getAttribute("aria-describedby")!)!.textContent).toBe(T.review.blockers.locked);
    });
});

describe("W11 activation: honest outcomes, secrets", () => {
    const fillDb = () => {
        for (const [label, v] of [[T.consistency.fields.host, "demo-db"], [T.consistency.fields.port, "5432"], [T.consistency.fields.username, "demo"], [T.consistency.fields.database, "demo"]] as const) fireEvent.change(screen.getByLabelText(new RegExp(`^${label} \\*$`)), {target: {value: v}});
        fireEvent.change(screen.getByLabelText(new RegExp(T.consistency.fields.password)), {target: {value: PW}});
    };
    it("sends the strict input once, password only in `secrets`, clears the password field, announces; success panel appears only for ok:true", async () => {
        activateAction.mockResolvedValue(okActivate);
        const {container} = mount(w11View({db: true}));
        pickChannel(/offsite/);
        fillDb();
        const pwEl = screen.getByLabelText(new RegExp(T.consistency.fields.password)) as HTMLInputElement;
        expect(screen.queryByTestId("activate-success")).toBeNull();
        await act(async () => { fireEvent.click(screen.getByTestId("activate")); });
        await waitFor(() => expect(activateAction).toHaveBeenCalledTimes(1));
        const sent = activateAction.mock.calls[0][0];
        expect(sent.secrets).toEqual({db: PW});
        expect(JSON.stringify({...sent, secrets: undefined})).not.toContain(PW);
        expect(sent).toMatchObject({stackId: STACK_ID, storageChannelIds: [CH_S3], schedule: {preset: "daily", timezone: "UTC"}, retention: {keep_last: 3}, selection: {databases: {db: {kind: "dump", host: "demo-db", port: 5432}}}});
        expect(JSON.stringify(previewAction.mock.calls)).not.toContain(PW);
        expect(pwEl.value).toBe("");
        const ok = await screen.findByTestId("activate-success");
        expect(ok.getAttribute("role")).toBe("status");
        expect(container.textContent).not.toContain(PW);
        expect(refresh).toHaveBeenCalled();
        expect((await screen.findAllByTestId("job-status"))[0].textContent).toBe(T.review.success.title);
    });

    it("a refusal shows the server's reason (never success), clears the password, maps selection issues to the field", async () => {
        activateAction.mockResolvedValue({data: {ok: false, code: "refused", reason: "selection_invalid", message: "x", issues: [{field: "databases:db", key: "db:db", code: "db_input_invalid"}]}});
        mount(w11View({db: true}));
        pickChannel(/offsite/);
        fillDb();
        const pwEl = screen.getByLabelText(new RegExp(T.consistency.fields.password)) as HTMLInputElement;
        await act(async () => { fireEvent.click(screen.getByTestId("activate")); });
        const fail = await screen.findByTestId("activate-failure");
        expect(fail.getAttribute("role")).toBe("alert");
        expect(fail.textContent).toContain(T.review.failure.selection_invalid);
        expect(screen.queryByTestId("activate-success")).toBeNull();
        expect(pwEl.value).toBe("");
        expect(within(screen.getByTestId("db-block")).getByRole("alert").textContent).toBe(T.fieldErrors.db_input_invalid);
    });

    it("every server refusal reason has its own sentence; a transport failure says nothing is known to have changed", async () => {
        for (const reason of ["encryption_required", "local_only_channels", "secret_required", "method_change", "agent_unavailable", "activation_failed", "channels_unavailable"]) {
            cleanup();
            activateAction.mockResolvedValue({data: {ok: false, code: "refused", reason, message: "x"}});
            mount(w11View());
            pickChannel(/offsite/);
            await act(async () => { fireEvent.click(screen.getByTestId("activate")); });
            expect((await screen.findByTestId("activate-failure")).textContent).toContain(T.review.failure[reason]);
        }
        cleanup();
        activateAction.mockRejectedValue(new Error("network"));
        mount(w11View());
        pickChannel(/offsite/);
        await act(async () => { fireEvent.click(screen.getByTestId("activate")); });
        expect((await screen.findByTestId("activate-failure")).textContent).toContain(T.review.transport);
        expect(screen.queryByTestId("activate-success")).toBeNull();
    });

    it("deferred docker volumes are reported next to the success, not hidden", async () => {
        activateAction.mockResolvedValue({data: {...okActivate.data, deferred: [{key: "volume:app_data", reason: "docker_access_unconfirmed"}], skipped: [{key: "mount:m:0000000000000009", reason: "anonymous_volume"}]}});
        mount(w11View());
        pickChannel(/offsite/);
        await act(async () => { fireEvent.click(screen.getByTestId("activate")); });
        const ok = await screen.findByTestId("activate-success");
        expect(ok.textContent).toContain(T.review.success.deferred(1));
        expect(screen.getByTestId("skipped-list").textContent).toContain(T.review.success.skipReason.anonymous_volume);
    });

    it("nothing is sent or stored while editing (UX-04): no activate call, no storage, no URL change", () => {
        const before = window.location.href;
        mount(w11View());
        pickChannel(/offsite/);
        fireEvent.click(screen.getByRole("checkbox", {name: T.resources.include("app_data")}));
        expect(activateAction).not.toHaveBeenCalled();
        expect(window.location.href).toBe(before);
        expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
    });
});

describe("W11 Schedule tab (placeholder for W13)", () => {
    const policy = {activatedAt: "2026-11-07T10:00:00.000Z", schedule: {preset: "daily" as const, timezone: "Europe/Berlin", minute: 30, hour: 2, weekday: 0, monthday: 1}, cron: "30 2 * * *", nextRuns: ["2026-11-08T01:30:00.000Z", "2026-11-09T01:30:00.000Z", "2026-11-10T01:30:00.000Z"],
        retention: {keep_last: 3, daily: 7, weekly: 4, monthly: 6, yearly: 0}, channels: [{name: "offsite", provider: "s3", local: false}, {name: "dashboard-local", provider: "local", local: true}], consistency: "crash" as const, sourceCount: 2};
    it("no policy: honest empty state + a configure link for administrators only", async () => {
        const {container, rerender} = render(<ScheduleTab policy={null} stackId={STACK_ID} canConfigure configureHref={`/dashboard/stacks/${STACK_ID}/configure`}/>);
        expect(screen.getByText(SCHEDULE_TAB.none.title)).toBeTruthy();
        expect(screen.getByRole("link", {name: SCHEDULE_TAB.configure}).getAttribute("href")).toBe(`/dashboard/stacks/${STACK_ID}/configure`);
        rerender(<ScheduleTab policy={null} stackId={STACK_ID} canConfigure={false} configureHref="/x"/>);
        expect(screen.queryByRole("link")).toBeNull();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("activated policy: schedule, timezone, next runs, retention, channels (local flagged), sources, and the 'runs are not built' note", async () => {
        const {container} = render(<ScheduleTab policy={policy} stackId={STACK_ID} canConfigure configureHref="/x"/>);
        const t = screen.getByTestId("schedule-tab").textContent!;
        for (const s of ["30 2 * * *", "Europe/Berlin", "newest 3, then 7 daily, 4 weekly, 6 monthly, 0 yearly", "offsite (s3)", SCHEDULE_TAB.local, SCHEDULE_TAB.note, SCHEDULE_TAB.consistency.crash]) expect(t).toContain(s);
        expect(await axeViolations(container)).toEqual([]);
    });
});
