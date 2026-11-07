// @vitest-environment jsdom
import {render} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {axeViolations} from "@/fork/__tests__/axe";
import {richInventory} from "@/fork/__tests__/w08-fixtures";
import {okState} from "@/fork/__tests__/w09-fixtures";
import {ForkForbiddenError, ForkNotFoundError, type ForkPrincipal} from "@/fork/acl";
import {StackDetailSchema, StackListSchema} from "@/fork/stacks/dto";
import {STACKS_EMPTY} from "@/fork/ui/labels";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const ID = "0b7e1c1e-7f3a-4b6e-9a40-111111111111";
const h = vi.hoisted(() => ({principal: null as null | ForkPrincipal, org: "x" as string | null, list: vi.fn(), detail: vi.fn(), resource: vi.fn()}));
vi.mock("@/fork/actions/stack-run.action", () => ({startStackRunAction: vi.fn(), cancelStackRunAction: vi.fn()}));
vi.mock("@/fork/actions/stack-schedule.action", () => ({updateStackScheduleAction: vi.fn()}));
vi.mock("next/navigation", () => ({notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, useRouter: () => ({refresh: () => {}})}));
vi.mock("@/fork/principal", () => ({getForkPrincipal: async () => h.principal}));
vi.mock("@/fork/db/handle", () => ({appDb: async () => ({tag: "db"})}));
vi.mock("@/fork/arcane/connection-service", () => ({soleOrganization: async () => h.org}));
vi.mock("@/fork/stacks/queries", () => ({loadStackList: h.list, loadStackDetail: h.detail}));
vi.mock("@/fork/resource-scope", () => ({assertForkResource: h.resource}));

import StackDetailsPage from "../../../../app/(customer)/dashboard/(organization)/stacks/[stackId]/page";
import StacksPage from "../../../../app/(customer)/dashboard/(organization)/stacks/page";

const P = (role: string | null, orgRole: string | null): ForkPrincipal => ({userId: "u", systemRole: role, memberships: orgRole ? [{organizationId: ORG, role: orgRole}] : []});
const LIST = StackListSchema.parse({items: [], total: 0, page: 1, pageSize: 25, summary: {total: 0, unprotected: 0, staleOrGone: 0}, environments: [], syncing: false, circuitOpen: false, setup: {connected: false, enabledEnvironments: 0}});
const DETAIL = StackDetailSchema.parse({id: ID, name: "forklab-demo", composeProject: "forklab-demo", environmentName: "local", runtime: "running", protection: "unprotected", staleSince: null, lastSyncAt: null, syncing: false, inventory: okState(richInventory())});
const on = () => { process.env.FORK_STACKS_ENABLED = "true"; };
const sp = (o: Record<string, string> = {}) => Promise.resolve(o);
const mountList = async (o: Record<string, string> = {}) => render(await StacksPage({searchParams: sp(o)}));
const mountDetail = async (o: Record<string, string> = {}) => render(await StackDetailsPage({params: Promise.resolve({stackId: ID}), searchParams: sp(o)}));

beforeEach(() => {
    h.principal = P("user", "member"); h.org = ORG;
    h.list.mockReset(); h.list.mockResolvedValue(LIST);
    h.detail.mockReset(); h.detail.mockResolvedValue(DETAIL);
    h.resource.mockReset(); h.resource.mockResolvedValue({organizationId: ORG});
});

describe("Docker Stacks list page: mode × role matrix (SEC-12, ADR-010)", () => {
    it("flags off → 404 for everyone; nothing is loaded", async () => {
        for (const p of [P("user", "member"), P("superadmin", "owner"), null]) {
            h.principal = p;
            await expect(StacksPage({searchParams: sp()})).rejects.toThrow("NEXT_NOT_FOUND");
        }
        expect(h.list).not.toHaveBeenCalled();
    });
    it("no usable principal (anonymous, pending, banned all resolve to null) → 404", async () => {
        on(); h.principal = null;
        await expect(StacksPage({searchParams: sp()})).rejects.toThrow("NEXT_NOT_FOUND");
        expect(h.list).not.toHaveBeenCalled();
    });
    it("authenticated non-member (user with no membership, even a superadmin) → unauthorized state, NO data loaded", async () => {
        on();
        for (const p of [P("user", null), P("superadmin", null), P("admin", null)]) {
            h.principal = p;
            const {container, unmount} = await mountList();
            expect(container.querySelector('[data-testid="unauthorized"]')?.textContent).toContain(STACKS_EMPTY.unauthorized.title);
            expect(await axeViolations(container)).toEqual([]);
            unmount();
        }
        expect(h.list).not.toHaveBeenCalled();
    });
    it("members, admins and owners of the organization see the list; the loader gets the org from the server, never from the request", async () => {
        on();
        for (const org of ["member", "admin", "owner"]) {
            h.principal = P("user", org);
            h.list.mockClear();
            const {container, unmount} = await mountList({q: "demo", organization: "evil-org-id", organizationId: "evil"});
            expect(container.querySelector('[data-testid="stacks-empty"]')).toBeTruthy();
            expect(h.list).toHaveBeenCalledTimes(1);
            const [db, orgArg, params] = h.list.mock.calls[0];
            expect(db).toEqual({tag: "db"});
            expect(orgArg).toBe(ORG);
            expect(params).toMatchObject({q: "demo", page: 1});
            expect(JSON.stringify(params)).not.toContain("evil");
            unmount();
        }
    });
    it("empty state is role-aware at the page level: system admin member gets the Integrations link, plain member does not", async () => {
        on();
        h.principal = P("admin", "owner");
        let r = await mountList();
        expect(r.container.querySelector('a[href="/dashboard/integrations"]')).toBeTruthy();
        r.unmount();
        h.principal = P("user", "member");
        r = await mountList();
        expect(r.container.querySelector('a[href="/dashboard/integrations"]')).toBeNull();
        expect(r.container.textContent).toContain(STACKS_EMPTY.noConnection.member);
    });
    it("loader failure → honest role=alert error, no stack trace, no cached claim", async () => {
        on(); h.list.mockRejectedValue(new Error("connection refused 10.0.0.5 password=hunter2"));
        const {container} = await mountList();
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(STACKS_EMPTY.loadError.title);
        expect(container.textContent).not.toContain("hunter2");
        expect(await axeViolations(container)).toEqual([]);
    });
    it("no single organization → explicit text, nothing loaded", async () => {
        on(); h.org = null;
        const {container} = await mountList();
        expect(container.querySelector('[data-testid="no-org"]')).toBeTruthy();
        expect(h.list).not.toHaveBeenCalled();
    });
    it("locked mode (flags on, self-check failing, an activated policy exists): still viewable, with a note", async () => {
        on();
        const {registerActivePolicyProbe, registerSelfCheck} = await import("@/fork/mode");
        registerActivePolicyProbe(async () => 1);
        registerSelfCheck(async () => ({ok: false, failed: "signup-open"}));
        const {container} = await mountList();
        expect(container.querySelector('[data-testid="locked-note"]')?.textContent).toBe(STACKS_EMPTY.locked);
        expect(h.list).toHaveBeenCalled();
    });
    it("flags on but mode off (self-check failing, nothing activated) → the fork stays invisible: 404", async () => {
        on();
        const {registerSelfCheck} = await import("@/fork/mode");
        registerSelfCheck(async () => ({ok: false, failed: "org-count"}));
        await expect(StacksPage({searchParams: sp()})).rejects.toThrow("NEXT_NOT_FOUND");
    });
});

describe("Stack details page (SEC-12 resource-scoped, no existence oracle)", () => {
    it("flags off / no principal → 404 before anything is read", async () => {
        await expect(mountDetail()).rejects.toThrow("NEXT_NOT_FOUND");
        on(); h.principal = null;
        await expect(mountDetail()).rejects.toThrow("NEXT_NOT_FOUND");
        expect(h.resource).not.toHaveBeenCalled();
        expect(h.detail).not.toHaveBeenCalled();
    });
    it("authorisation runs first with stacks.view on the stack resource; not found (missing, malformed, other org) → 404 and the loader is never reached", async () => {
        on();
        h.resource.mockRejectedValue(new ForkNotFoundError());
        await expect(mountDetail()).rejects.toThrow("NEXT_NOT_FOUND");
        expect(h.resource).toHaveBeenCalledWith({tag: "db"}, h.principal, "stacks.view", {kind: "stack", id: ID});
        expect(h.detail).not.toHaveBeenCalled();
    });
    it("a member of the owning org without the capability gets the honest unauthorized state, no data", async () => {
        on(); h.resource.mockRejectedValue(new ForkForbiddenError("stacks.view"));
        const {container} = await mountDetail();
        expect(container.querySelector('[data-testid="unauthorized"]')).toBeTruthy();
        expect(h.detail).not.toHaveBeenCalled();
    });
    it("authorised: loads with the organization returned by the authorisation (not the request) and renders; ?tab selects the tab; bogus tab falls back", async () => {
        on();
        let r = await mountDetail({tab: "resources"});
        expect(h.detail).toHaveBeenCalledWith({tag: "db"}, ORG, ID, {configLocked: false, rp: null});
        expect(r.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Resources");
        expect(await axeViolations(r.container)).toEqual([]);
        r.unmount();
        r = await mountDetail({tab: "<script>"});
        expect(r.container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Overview");
    });
    it("loader returns null (raced delete) → 404; loader throws → honest error without details", async () => {
        on();
        h.detail.mockResolvedValue(null);
        await expect(mountDetail()).rejects.toThrow("NEXT_NOT_FOUND");
        h.detail.mockRejectedValue(new Error("secret db detail"));
        const {container} = await mountDetail();
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(STACKS_EMPTY.loadError.title);
        expect(container.textContent).not.toContain("secret db detail");
    });
});
