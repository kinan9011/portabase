// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {KIT_NONE, type KitView} from "@/fork/kit/service";
import {KIT} from "@/fork/ui/labels";

const begin = vi.fn();
const confirm = vi.fn();
vi.mock("@/fork/actions/kit.action", () => ({beginKitGenerationAction: (...a: unknown[]) => begin(...a), confirmKitFingerprintAction: (...a: unknown[]) => confirm(...a), rotateKekAction: vi.fn()}));
vi.mock("@/fork/actions/dashboard-db.action", () => ({declareDashboardDbSourceAction: vi.fn()}));

import {KitBanner} from "@/fork/ui/kit/kit-banner";
import {DashboardDbCard, KekCard} from "@/fork/ui/kit/kit-extras.client";
import {KitPanel} from "@/fork/ui/kit/kit-panel.client";

const view = (o: Partial<KitView> = {}): KitView => ({...KIT_NONE, ...o});
beforeEach(() => { begin.mockReset(); confirm.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("kit banner (D41)", () => {
    it("shows for none/issued/stale with an active policy, never when verified or when no policy is active; the admin link is admin-only", async () => {
        const {container, rerender} = render(<KitBanner view={view()} hasActivePolicy isAdmin/>);
        expect(screen.getByTestId("kit-banner").getAttribute("data-kit-state")).toBe("none");
        expect(screen.getByRole("link", {name: KIT.banner.none.cta}).getAttribute("href")).toBe("/dashboard/integrations/recovery-kit");
        expect(await axeViolations(container)).toEqual([]);
        rerender(<KitBanner view={view({state: "issued"})} hasActivePolicy isAdmin={false}/>);
        expect(screen.getByText(KIT.banner.issued.title)).toBeTruthy();
        expect(screen.queryByRole("link")).toBeNull(); // members see the sentence, not a link they cannot use
        rerender(<KitBanner view={view({state: "stale"})} hasActivePolicy isAdmin/>);
        expect(screen.getByText(KIT.banner.stale.title)).toBeTruthy();
        rerender(<KitBanner view={view({state: "verified", verifiedAt: "2026-11-07T00:00:00Z", verifiedType: "paper"})} hasActivePolicy isAdmin/>);
        expect(screen.queryByTestId("kit-banner")).toBeNull();
        rerender(<KitBanner view={view()} hasActivePolicy={false} isAdmin/>);
        expect(screen.queryByTestId("kit-banner")).toBeNull();
    });
});

describe("kit panel (secrets never enter React state, the page, or storage)", () => {
    it("is accessible; forms post; the password and passphrases are password inputs, never prefilled", async () => {
        const {container} = render(<KitPanel view={view()} canManage lockedReason={null}/>);
        expect(await axeViolations(container)).toEqual([]);
        for (const f of container.querySelectorAll("form")) expect(f.getAttribute("method")).toBe("post");
        const pw = container.querySelector('input[name="kit-password"]') as HTMLInputElement;
        expect(pw.type).toBe("password"); expect(pw.value).toBe(""); expect(pw.getAttribute("autocomplete")).toBe("current-password"); // W27b D-06 (1.3.5): the account password states its purpose
        expect(screen.getByTestId("kit-state").getAttribute("data-kit-state")).toBe("none");
    });

    it("non-admin / locked: everything is disabled with a visible reason", () => {
        render(<KitPanel view={view()} canManage={false} lockedReason={null}/>);
        expect(screen.getByText(KIT.page.notAdmin)).toBeTruthy();
        expect((screen.getByRole("button", {name: KIT.create.start}) as HTMLButtonElement).disabled).toBe(true);
        cleanup();
        render(<KitPanel view={view()} canManage lockedReason="Fork configuration locked: x"/>);
        expect(screen.getByText("Fork configuration locked: x")).toBeTruthy();
        expect((screen.getByRole("button", {name: KIT.confirm.button}) as HTMLButtonElement).disabled).toBe(true);
    });

    it("step-up: the password is read once, sent to the action only and cleared; the paper view appears only after the grant is spent and holds no storage", async () => {
        begin.mockResolvedValue({data: {ok: true, tokens: {paper: "p".repeat(30)}, expiresInSeconds: 300}});
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({kind: "paper", html: "<html><body>PAPER-KIT-TEST-ONLY</body></html>"}), {status: 200}));
        vi.stubGlobal("fetch", fetchMock);
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        const {container} = render(<KitPanel view={view()} canManage lockedReason={null}/>);
        expect(screen.queryByTestId("kit-print-view")).toBeNull();
        const pw = container.querySelector('input[name="kit-password"]') as HTMLInputElement;
        fireEvent.change(pw, {target: {value: "account-pass-TEST"}});
        fireEvent.submit(pw.closest("form") as HTMLFormElement);
        await waitFor(() => expect(begin).toHaveBeenCalledWith({types: ["paper"], password: "account-pass-TEST"}));
        expect(pw.value).toBe(""); // cleared at submit
        fireEvent.click(await screen.findByRole("button", {name: KIT.create.paperButton}));
        const view1 = await screen.findByTestId("kit-print-view");
        expect(view1.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-same-origin allow-modals"); // scripts disabled
        expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("/api/fork/kit/paper");
        const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
        expect(init.cache).toBe("no-store"); expect(init.method).toBe("POST");
        // the grant is spent: the button is gone; closing forgets the kit
        expect(screen.queryByRole("button", {name: KIT.create.paperButton})).toBeNull();
        fireEvent.click(screen.getByRole("button", {name: KIT.create.closeButton}));
        expect(screen.queryByTestId("kit-print-view")).toBeNull();
        expect(setItem).not.toHaveBeenCalled(); // nothing in localStorage/sessionStorage
        expect(document.body.innerHTML).not.toContain("PAPER-KIT-TEST-ONLY");
        vi.unstubAllGlobals();
    });

    it("a refusal shows a plain sentence (never the raw code) and the code input is cleared after every attempt", async () => {
        confirm.mockResolvedValue({data: {ok: false, code: "wrong_code", message: "x"}});
        const {container} = render(<KitPanel view={view({state: "issued", types: ["paper"], issuedAt: "2026-11-07T00:00:00Z"})} canManage lockedReason={null}/>);
        const input = container.querySelector("#kit-code") as HTMLInputElement;
        fireEvent.change(input, {target: {value: "AAAA-BBBB-CCCC-DDDD-EEEE"}});
        fireEvent.submit(input.closest("form") as HTMLFormElement);
        await waitFor(() => expect(screen.getByTestId("kit-status").textContent).toBe(KIT.errors.wrong_code));
        expect(input.value).toBe("");
        expect(confirm).toHaveBeenCalledWith({fingerprint: "AAAA-BBBB-CCCC-DDDD-EEEE", type: "paper"});
    });
});

describe("D40 + KEK cards", () => {
    it("render accessibly with the honest verdict sentence", async () => {
        const {container} = render(<div><DashboardDbCard view={{verdict: "shared_channel", sourceName: "x", hasSchedule: true, lastSuccessAt: null, channels: [{name: "c1", provider: "s3", local: false, sharedWithOtherHosts: true}]}} candidates={[{id: "a", name: "pg", agentName: "agent"}]} disabled={false}/><KekCard disabled={false}/></div>);
        expect(screen.getByTestId("dashboard-db-verdict").textContent).toContain("also used by another host");
        expect(await axeViolations(container)).toEqual([]);
    });
});
