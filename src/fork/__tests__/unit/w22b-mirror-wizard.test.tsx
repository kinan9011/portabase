// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor, within} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {CreateMirrorRequest} from "@/fork/mirror/service";
import {keepConfirmPhrase, PRIVACY_ACK} from "@/fork/mirror/vocab";
import {BANNER, MIRROR_REFUSAL_TEXT, MIRRORS, RUNNER_REASON_TEXT, isolationUnknownText} from "@/fork/ui/mirrors/labels";
import type {RunnerUi} from "@/fork/ui/mirrors/wizard/model";
import {StatusAnnouncer} from "@/fork/ui/status-announcer";

const h = vi.hoisted(() => ({push: vi.fn(), refresh: vi.fn(), optIn: vi.fn(), probe: vi.fn(), preview: vi.fn(), create: vi.fn()}));
vi.mock("next/navigation", () => ({useRouter: () => ({push: h.push, refresh: h.refresh})}));
vi.mock("@/fork/actions/mirror.action", () => ({setStackMirrorOptInAction: h.optIn, previewMirrorPlanAction: h.preview, createMirrorAction: h.create}));
vi.mock("@/fork/actions/runner.action", () => ({requestRunnerProbeAction: h.probe}));

import {MirrorWizardSteps, type WizardData} from "@/fork/ui/mirrors/wizard/wizard-steps.client";

const ID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const RP = "0b7e1c1e-7f3a-4b6e-9a40-222222222222";
const RN = "0b7e1c1e-7f3a-4b6e-9a40-333333333333";
const source = {
    inventoryVersion: 1,
    services: [
        {name: "web", ports: [{target: 8080, protocol: "tcp" as const, published: true}], database: null, env: [{key: "APP_NAME", recommended: "keep" as const}, {key: "DB_PASSWORD", recommended: "rotate" as const}, {key: "SMTP_URL", recommended: "disable" as const}]},
        {name: "db", ports: [{target: 5432, protocol: "tcp" as const, published: false}], database: "postgresql", env: [{key: "POSTGRES_PASSWORD", recommended: "rotate" as const}]},
    ],
    privacy: {containsPersonalData: true as boolean | null, optIn: true},
};
const runner = (o: Partial<RunnerUi> = {}): RunnerUi => ({id: RN, name: "lab-runner", status: "online", eligible: true, ineligible: null, isolation: "isolated", isolationUnknown: null, probedAt: new Date().toISOString(), reachableCount: 0, targetCount: 1, probePending: false, busy: false, mirrorsHeld: 0, freePorts: 1000, ...o});
const base = (o: Partial<WizardData> = {}): WizardData => ({
    step: "source", dropped: false, locked: false, nowIso: new Date().toISOString(), stackId: ID, stackName: "My Shop", pointSeq: null, isSysAdmin: false, canProbe: false, runners: [], runnerId: null, configure: null,
    points: [{id: RP, sequence: 3, verified: true, label: "Nov 14, 2026", relative: "1 hour ago", size: "12 MB", statusText: "Verified"}, {id: "x", sequence: 2, verified: false, label: "Nov 13, 2026", relative: "1 day ago", size: null, statusText: "Backed up · verifying"}],
    privacy: {containsPersonalData: false, optIn: false}, ...o,
});
const configure = (o: Record<string, unknown> = {}) => base({step: "configure", pointSeq: 3, runnerId: RN, configure: {stackId: ID, stackName: "My Shop", rp: {id: RP, sequence: 3, label: "Nov 14, 2026"}, runner: {id: RN, name: "lab-runner"}, source, locked: false, ...o}});
const mount = (d: WizardData) => render(<StatusAnnouncer><MirrorWizardSteps data={d}/></StatusAnnouncer>);
const next = (name: RegExp | string) => fireEvent.click(screen.getByRole("button", {name}));
const pick = async (name: string, option: string) => { fireEvent.keyDown(screen.getByRole("combobox", {name}), {key: "Enter"}); fireEvent.click(await screen.findByRole("option", {name: option})); };
const READY = {data: {ok: true, outcome: "ready", blockers: [], actions: 4, containsPersonalData: true, optIn: true, runnerIsolation: "isolated"}};

beforeEach(() => {
    for (const f of [h.push, h.refresh, h.optIn, h.probe, h.preview, h.create]) f.mockReset();
    h.preview.mockResolvedValue(READY);
});
afterEach(cleanup);

describe("step 1: source", () => {
    it("verified recovery points are radios, unverified ones aria-disabled with the reason; Next goes to the runner step; one role=status; axe clean", async () => {
        const {container} = mount(base());
        expect(screen.getAllByRole("radio").length).toBe(1);
        const un = within(screen.getByTestId("source-unavailable")).getByRole("listitem");
        expect(un.getAttribute("aria-disabled")).toBe("true");
        expect(un.textContent).toContain(MIRRORS.source.verifiedOnly);
        expect(container.querySelectorAll("[role=status]").length).toBe(1);
        next(MIRRORS.steps.next.runner);
        expect(h.push).toHaveBeenCalledWith(`/dashboard/mirrors/new?step=runner&stack=${ID}&point=3`);
        expect(await axeViolations(container)).toEqual([]);
    });
    it("no verified recovery point ⇒ honest empty state, no Next", () => {
        mount(base({points: []}));
        expect(screen.getByTestId("source-empty").textContent).toBe(MIRRORS.source.none);
        expect(screen.queryByRole("button", {name: MIRRORS.steps.next.runner})).toBeNull();
    });
    it("no stack in the URL ⇒ a note with a link to the apps (no stack picker)", () => {
        mount(base({stackId: null, stackName: null, points: [], privacy: null}));
        expect(screen.getByTestId("no-stack").querySelector("a")?.getAttribute("href")).toBe("/dashboard/stacks");
    });
    it("a dropped choice is announced as a note", () => {
        mount(base({dropped: true}));
        expect(screen.getByTestId("choice-gone").textContent).toBe(MIRRORS.gone);
    });
    const needs = {containsPersonalData: null, optIn: false};
    it("personal data unknown + no opt-in: an organization admin sees the reason and a blocked Next (no allow button)", async () => {
        const {container} = mount(base({privacy: needs, isSysAdmin: false}));
        expect(screen.queryByTestId("optin-allow")).toBeNull();
        const nx = screen.getByRole("button", {name: MIRRORS.steps.next.runner});
        expect(nx.getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(nx.getAttribute("aria-describedby")!)?.textContent).toBe(MIRRORS.source.privacy.adminOnly);
        fireEvent.click(nx);
        expect(h.push).not.toHaveBeenCalled();
        expect(await axeViolations(container)).toEqual([]);
    });
    it("a system admin allows mirrors through a confirm dialog: Escape cancels and returns focus, Confirm calls the audited action and refreshes", async () => {
        h.optIn.mockResolvedValue({data: {ok: true}});
        const {container} = mount(base({privacy: needs, isSysAdmin: true}));
        const open = screen.getByTestId("optin-allow");
        open.focus();
        fireEvent.click(open);
        const dlg = await screen.findByRole("alertdialog");
        expect(dlg.textContent).toContain(MIRRORS.source.privacy.allowBody);
        fireEvent.keyDown(dlg, {key: "Escape"});
        await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(open));
        expect(h.optIn).not.toHaveBeenCalled();
        fireEvent.click(open);
        fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", {name: MIRRORS.source.privacy.allowConfirm}));
        await waitFor(() => expect(h.optIn).toHaveBeenCalledWith({stackId: ID, enabled: true}));
        await waitFor(() => expect(h.refresh).toHaveBeenCalled());
        expect(await axeViolations(container)).toEqual([]);
    });
    it("a refused opt-in is reported, not swallowed", async () => {
        h.optIn.mockResolvedValue({data: {ok: false, code: "forbidden"}});
        mount(base({privacy: needs, isSysAdmin: true}));
        fireEvent.click(screen.getByTestId("optin-allow"));
        fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", {name: MIRRORS.source.privacy.allowConfirm}));
        expect((await screen.findByTestId("optin-error")).textContent).toBe(MIRRORS.source.privacy.failed);
        expect(h.refresh).not.toHaveBeenCalled();
    });
});

describe("step 2: runner", () => {
    const two = base({step: "runner", pointSeq: 3, runners: [runner(), runner({id: "r2", name: "off-runner", status: "offline"})], runnerId: null});
    it("a selectable runner with its capacity facts; an unavailable one is aria-disabled with its visible reason; Next needs a choice", async () => {
        const {container} = mount(two);
        const opt = screen.getByTestId("runner-option");
        expect(opt.textContent).toContain("lab-runner");
        expect(opt.textContent).toContain(MIRRORS.runner.facts.limits);
        expect(opt.textContent).toContain(MIRRORS.runner.facts.disk); // honest: not reported
        expect(opt.textContent).toContain("1000 free ports");
        const dis = screen.getByTestId("runner-disabled");
        expect(dis.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByTestId("runner-reason").textContent).toBe(RUNNER_REASON_TEXT.offline);
        const nx = screen.getByRole("button", {name: MIRRORS.steps.next.access});
        expect(nx.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(nx);
        expect(h.push).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("radio"));
        fireEvent.click(nx);
        expect(h.push).toHaveBeenCalledWith(`/dashboard/mirrors/new?step=configure&stack=${ID}&point=3&runner=${RN}`);
        expect(await axeViolations(container)).toEqual([]);
    });
    it.each<[string, Partial<RunnerUi>, string]>([
        ["not isolated", {isolation: "not_isolated", reachableCount: 2}, RUNNER_REASON_TEXT.not_isolated],
        ["isolation unknown", {isolation: "unknown", isolationUnknown: "stale"}, isolationUnknownText("stale")],
        ["no probe targets", {targetCount: 0}, RUNNER_REASON_TEXT.no_targets],
        ["busy", {busy: true}, RUNNER_REASON_TEXT.busy],
        ["no free port", {freePorts: 0}, RUNNER_REASON_TEXT.no_ports],
        ["not attested", {eligible: false, ineligible: "not_attested"}, RUNNER_REASON_TEXT.not_attested],
    ])("%s ⇒ disabled with its reason", (_n, over, reason) => {
        mount(base({step: "runner", pointSeq: 3, runners: [runner(over)]}));
        expect(screen.queryByTestId("runner-option")).toBeNull();
        expect(screen.getByTestId("runner-reason").textContent).toBe(reason);
    });
    it("no runner ⇒ honest empty state; the system admin gets the operator hint", () => {
        const {unmount} = mount(base({step: "runner", pointSeq: 3, runners: [], isSysAdmin: true}));
        expect(screen.getByTestId("runner-empty").textContent).toContain(MIRRORS.runner.emptyAdmin);
        unmount();
        mount(base({step: "runner", pointSeq: 3, runners: []}));
        expect(screen.getByTestId("runner-empty").textContent).toContain(MIRRORS.runner.emptyMember);
    });
    it("the isolation check is for system admins only: it calls the action once with the agent id and announces", async () => {
        h.probe.mockResolvedValue({data: {ok: true}});
        const d = base({step: "runner", pointSeq: 3, isSysAdmin: true, canProbe: true, runners: [runner({isolation: "unknown", isolationUnknown: "never_probed"})]});
        const {unmount} = mount(d);
        fireEvent.click(screen.getByTestId("runner-check"));
        await waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1));
        expect(h.probe).toHaveBeenCalledWith({agentId: RN});
        await waitFor(() => expect(screen.getByTestId("job-status").textContent).toBe(MIRRORS.runner.checkRequested));
        unmount();
        mount(base({step: "runner", pointSeq: 3, isSysAdmin: false, canProbe: false, runners: [runner({isolation: "unknown", isolationUnknown: "never_probed"})]}));
        expect(screen.queryByTestId("runner-check")).toBeNull();
    });
    it("a refused isolation check is reported", async () => {
        h.probe.mockResolvedValue({data: {ok: false, code: "forbidden"}});
        mount(base({step: "runner", pointSeq: 3, isSysAdmin: true, canProbe: true, runners: [runner({isolation: "unknown", isolationUnknown: "never_probed"})]}));
        fireEvent.click(screen.getByTestId("runner-check"));
        expect((await screen.findByTestId("runner-error")).textContent).toBe(MIRRORS.runner.checkFailed);
    });
});

describe("steps 3-5: configure", () => {
    it("defaults: steps 3 → 4 → 5 need zero edits, Create becomes enabled once the preview is ready, and the payload is exactly the defaults (overrides only)", async () => {
        h.create.mockResolvedValue({data: {ok: true, mirrorId: "m1"}});
        const {container} = mount(configure());
        expect(screen.getByRole("heading", {level: 1}).textContent).toBe(MIRRORS.steps.title.access);
        expect(screen.getByTestId("isolation-fact").textContent).toBe(MIRRORS.access.isolation);
        expect(await axeViolations(container)).toEqual([]);
        next(MIRRORS.steps.next.data);
        expect(await screen.findByTestId("step-data")).toBeTruthy();
        expect(await axeViolations(container)).toEqual([]);
        next(MIRRORS.steps.next.review);
        await screen.findByTestId("preview-ready");
        expect(screen.getByTestId("privacy-banner").textContent).toBe(BANNER("lab-runner"));
        const create = screen.getByTestId("create-mirror");
        expect(create.getAttribute("aria-disabled")).toBe("true"); // personal data ⇒ the acknowledgement is still required
        expect(document.getElementById(create.getAttribute("aria-describedby")!)?.textContent).toBe(MIRRORS.review.reasons.ack);
        fireEvent.click(screen.getByLabelText(PRIVACY_ACK));
        await waitFor(() => expect(create.getAttribute("aria-disabled")).toBeNull());
        expect(await axeViolations(container)).toEqual([]);
        fireEvent.click(create);
        await waitFor(() => expect(h.create).toHaveBeenCalledTimes(1));
        const sent = h.create.mock.calls[0]![0];
        expect(sent).toMatchObject({stackId: ID, rpId: RP, runnerAgentId: RN, name: "my-shop-3", acknowledgePrivacy: true, keepConfirmations: {}, policy: {v: 1, access: {service: "web", target: 8080}, http_path: "/", env: {}}});
        expect(CreateMirrorRequest.safeParse(sent).success).toBe(true);
        await waitFor(() => expect(h.push).toHaveBeenCalledWith("/dashboard/mirrors/m1"));
        expect(h.preview).toHaveBeenCalledWith({stackId: ID, rpId: RP, runnerAgentId: RN});
    });
    it("a stack without personal data needs no acknowledgement checkbox", async () => {
        mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        next(MIRRORS.steps.next.data); next(MIRRORS.steps.next.review);
        await screen.findByTestId("preview-ready");
        expect(screen.queryByLabelText(PRIVACY_ACK)).toBeNull();
        expect(screen.getByTestId("create-mirror").getAttribute("aria-disabled")).toBeNull();
        expect(screen.getByTestId("privacy-banner")).toBeTruthy(); // the banner is always shown
    });
    it("service / port / path: the port list follows the service, an invalid path blocks Next with a visible reason, 'no web page' sends http_path null", async () => {
        h.create.mockResolvedValue({data: {ok: true, mirrorId: "m1"}});
        mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        await pick(MIRRORS.access.service, "db");
        await waitFor(() => expect(screen.getByRole("combobox", {name: MIRRORS.access.port}).textContent).toContain("5432"));
        fireEvent.change(screen.getByLabelText(MIRRORS.access.path), {target: {value: "no-slash"}});
        const nx = screen.getByRole("button", {name: MIRRORS.steps.next.data});
        expect(nx.getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(nx.getAttribute("aria-describedby")!)?.textContent).toBe(MIRRORS.access.pathInvalid);
        fireEvent.click(screen.getByLabelText(MIRRORS.access.noHttp));
        expect(nx.getAttribute("aria-disabled")).toBeNull();
        next(MIRRORS.steps.next.data); next(MIRRORS.steps.next.review);
        await screen.findByTestId("preview-ready");
        fireEvent.click(screen.getByTestId("create-mirror"));
        await waitFor(() => expect(h.create).toHaveBeenCalled());
        expect(h.create.mock.calls[0]![0].policy).toMatchObject({access: {service: "db", target: 5432}, http_path: null});
    });
    it("no service with a port ⇒ honest note and Next stays blocked", () => {
        mount(configure({source: {...source, services: []}}));
        expect(screen.getByTestId("no-service").textContent).toBe(MIRRORS.access.noService);
        expect(screen.getByRole("button", {name: MIRRORS.steps.next.data}).getAttribute("aria-disabled")).toBe("true");
    });
    it("keeping a production value: Next stays blocked until the exact phrase is typed (case and extra space matter); the payload carries the phrase", async () => {
        h.create.mockResolvedValue({data: {ok: true, mirrorId: "m1"}});
        mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        next(MIRRORS.steps.next.data);
        await pick("web DB_PASSWORD", "Keep the production value");
        const nx = screen.getByRole("button", {name: MIRRORS.steps.next.review});
        expect(nx.getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(nx.getAttribute("aria-describedby")!)?.textContent).toBe(MIRRORS.review.reasons.keep);
        const phrase = keepConfirmPhrase("web", "DB_PASSWORD");
        const input = screen.getByLabelText(MIRRORS.data.typed(phrase));
        for (const bad of [phrase.toLowerCase(), `${phrase}x`, "KEEP web.DB_PASSWOR"]) { fireEvent.change(input, {target: {value: bad}}); expect(nx.getAttribute("aria-disabled")).toBe("true"); }
        fireEvent.change(input, {target: {value: ` ${phrase} `.trim()}});
        expect(nx.getAttribute("aria-disabled")).toBeNull();
        fireEvent.click(nx);
        await screen.findByTestId("preview-ready");
        expect(screen.getByTestId("kept-list").textContent).toBe("web.DB_PASSWORD");
        fireEvent.click(screen.getByTestId("create-mirror"));
        await waitFor(() => expect(h.create).toHaveBeenCalled());
        const sent = h.create.mock.calls[0]![0];
        expect(sent.policy.env).toEqual({web: {DB_PASSWORD: "keep_exact"}});
        expect(sent.keepConfirmations).toEqual({"web.DB_PASSWORD": phrase});
    });
    it("a changed (non-kept) setting is an override; recommended choices are labelled", async () => {
        h.create.mockResolvedValue({data: {ok: true, mirrorId: "m1"}});
        mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        next(MIRRORS.steps.next.data);
        expect(screen.getByRole("combobox", {name: "web SMTP_URL"}).textContent).toContain(`${"Switch off"} ${MIRRORS.data.recommended}`);
        await pick("web APP_NAME", "Remove");
        next(MIRRORS.steps.next.review);
        await screen.findByTestId("preview-ready");
        expect(screen.getByText(MIRRORS.review.changed(1))).toBeTruthy();
        fireEvent.click(screen.getByTestId("create-mirror"));
        await waitFor(() => expect(h.create).toHaveBeenCalled());
        expect(h.create.mock.calls[0]![0].policy.env).toEqual({web: {APP_NAME: "drop"}});
    });
    it("a blocked preview lists the blockers and keeps Create disabled; a runner that lost isolation too", async () => {
        h.preview.mockResolvedValue({data: {ok: true, outcome: "blocked", blockers: ["inventory_missing", "something_new"], actions: 0, containsPersonalData: false, optIn: false, runnerIsolation: "isolated"}});
        const {container} = mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        next(MIRRORS.steps.next.data); next(MIRRORS.steps.next.review);
        const b = await screen.findByTestId("preview-blocked");
        expect(within(b).getAllByRole("listitem").length).toBe(2);
        expect(b.textContent).toContain(MIRRORS.review.blockedGeneric); // unknown blocker ⇒ generic sentence
        const create = screen.getByTestId("create-mirror");
        expect(create.getAttribute("aria-disabled")).toBe("true");
        expect(document.getElementById(create.getAttribute("aria-describedby")!)?.textContent).toBe(MIRRORS.review.reasons.blocked);
        expect(await axeViolations(container)).toEqual([]);
        h.preview.mockResolvedValue({data: {ok: true, outcome: "ready", blockers: [], actions: 1, containsPersonalData: false, optIn: false, runnerIsolation: "unknown"}});
        fireEvent.click(screen.getByTestId("preview-again"));
        await screen.findByTestId("preview-ready");
        expect(screen.getByTestId("preview-isolation").textContent).toBe(MIRRORS.review.isolationNo);
        expect(document.getElementById(screen.getByTestId("create-mirror").getAttribute("aria-describedby")!)?.textContent).toBe(MIRRORS.review.reasons.isolation);
    });
    it("a failed preview shows the error and can be retried", async () => {
        h.preview.mockResolvedValueOnce({data: {ok: false, code: "mirrors_disabled"}});
        mount(configure());
        next(MIRRORS.steps.next.data); next(MIRRORS.steps.next.review);
        expect((await screen.findByTestId("preview-error")).textContent).toBe(MIRROR_REFUSAL_TEXT.mirrors_disabled);
        fireEvent.click(screen.getByTestId("preview-again"));
        await screen.findByTestId("preview-ready");
    });
    it("a locked configuration blocks Create with the locked reason", async () => {
        mount(configure({locked: true, source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        next(MIRRORS.steps.next.data); next(MIRRORS.steps.next.review);
        await screen.findByTestId("preview-ready");
        expect(document.getElementById(screen.getByTestId("create-mirror").getAttribute("aria-describedby")!)?.textContent).toBe(MIRRORS.review.reasons.locked);
    });
    it("an invalid name blocks Create with the name reason and marks the field", async () => {
        mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        next(MIRRORS.steps.next.data); next(MIRRORS.steps.next.review);
        await screen.findByTestId("preview-ready");
        const name = screen.getByLabelText(MIRRORS.review.name);
        fireEvent.change(name, {target: {value: "Bad Name"}});
        expect(name.getAttribute("aria-invalid")).toBe("true");
        expect(document.getElementById(screen.getByTestId("create-mirror").getAttribute("aria-describedby")!)?.textContent).toBe(MIRRORS.review.reasons.name);
    });
    const refusals = Object.keys(MIRROR_REFUSAL_TEXT).filter((c) => c !== "name_taken") as (keyof typeof MIRROR_REFUSAL_TEXT)[];
    it.each(refusals)("a '%s' refusal from the server renders its sentence in role=alert (never the raw code)", async (code) => {
        h.create.mockResolvedValue({data: {ok: false, code, message: "RAW-SERVER-MESSAGE", ...(code === "rate_limited" ? {retryAfterSeconds: 7} : {})}});
        mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        next(MIRRORS.steps.next.data); next(MIRRORS.steps.next.review);
        await screen.findByTestId("preview-ready");
        fireEvent.click(screen.getByTestId("create-mirror"));
        const al = await screen.findByTestId("create-refusal");
        expect(al.getAttribute("role")).toBe("alert");
        expect(al.textContent).toContain(code === "rate_limited" ? "7 s" : MIRROR_REFUSAL_TEXT[code]);
        expect(al.textContent).not.toContain("RAW-SERVER-MESSAGE");
        expect(h.push).not.toHaveBeenCalled();
    });
    it("name_taken marks the name field and keeps the page; plan_blocked lists its blockers; a server error is generic", async () => {
        h.create.mockResolvedValueOnce({data: {ok: false, code: "name_taken"}});
        mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        next(MIRRORS.steps.next.data); next(MIRRORS.steps.next.review);
        await screen.findByTestId("preview-ready");
        fireEvent.click(screen.getByTestId("create-mirror"));
        await waitFor(() => expect(screen.getByLabelText(MIRRORS.review.name).getAttribute("aria-invalid")).toBe("true"));
        expect(document.getElementById("mirror-name-h")?.textContent).toBe(MIRROR_REFUSAL_TEXT.name_taken);
        h.create.mockResolvedValueOnce({data: {ok: false, code: "plan_blocked", blockers: ["inventory_missing"]}});
        fireEvent.change(screen.getByLabelText(MIRRORS.review.name), {target: {value: "other-name"}});
        fireEvent.click(screen.getByTestId("create-mirror"));
        const al = await screen.findByTestId("create-refusal");
        expect(within(al).getAllByRole("listitem").length).toBe(1);
        h.create.mockResolvedValueOnce({serverError: "boom"});
        fireEvent.click(screen.getByTestId("create-mirror"));
        await waitFor(() => expect(screen.getByTestId("create-refusal").textContent).toBe(MIRRORS.review.previewError));
    });
    it("keyboard: the runner radio group moves and checks with the arrow keys", async () => {
        mount(base({step: "runner", pointSeq: 3, runners: [runner(), runner({id: "r3", name: "second"})]}));
        const radios = screen.getAllByRole("radio");
        radios[0]!.focus();
        fireEvent.keyDown(radios[0]!, {key: "ArrowDown"});
        await waitFor(() => expect(radios[1]!.getAttribute("data-state")).toBe("checked"));
        expect(document.activeElement).toBe(radios[1]);
        expect(radios[0]!.getAttribute("data-state")).toBe("unchecked");
    });
    it("the heading takes focus on every step change", async () => {
        mount(configure({source: {...source, privacy: {containsPersonalData: false, optIn: false}}}));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", {level: 1})));
        next(MIRRORS.steps.next.data);
        await waitFor(() => expect(screen.getByRole("heading", {level: 1}).textContent).toBe(MIRRORS.steps.title.data));
        expect(document.activeElement).toBe(screen.getByRole("heading", {level: 1}));
    });
});
