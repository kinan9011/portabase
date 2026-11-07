import {beforeEach, describe, expect, it, vi} from "vitest";

const gen = vi.fn();
vi.mock("@/fork/kit/service", () => ({generateKitArtifact: (...a: unknown[]) => gen(...a)}));
vi.mock("@/fork/db/handle", () => ({appDb: async () => ({})}));
vi.mock("@/fork/principal", () => ({getForkPrincipal: async () => ({userId: "u", systemRole: "admin", memberships: []})}));
vi.mock("@/fork/keys", () => ({fileKeyProvider: {}}));
const mode = vi.fn(async () => ({mode: "on"}));
vi.mock("@/fork/mode", () => ({currentForkMode: () => mode()}));

import {POST} from "../../../../app/api/fork/kit/[kind]/route";

const mk = (headers: Record<string, string> = {}, body: unknown = {token: "t".repeat(30)}) =>
    new Request("http://dash.test/api/fork/kit/paper", {method: "POST", headers: {"content-type": "application/json", "sec-fetch-site": "same-origin", ...headers}, body: JSON.stringify(body)});
const ctx = (kind: string) => ({params: Promise.resolve({kind})});

beforeEach(() => { gen.mockReset(); mode.mockResolvedValue({mode: "on"}); });

describe("kit delivery route (W14): one response, no-store, session only", () => {
    it("refuses cross-site, no-origin and non-JSON requests (CSRF guard first)", async () => {
        expect((await POST(mk({"sec-fetch-site": "cross-site"}), ctx("paper"))).status).toBe(403);
        const noOrigin = new Request("http://dash.test/api/fork/kit/paper", {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
        expect((await POST(noOrigin, ctx("paper"))).status).toBe(403);
        expect((await POST(mk({"content-type": "application/x-www-form-urlencoded"}), ctx("paper"))).status).toBe(403);
        expect(gen).not.toHaveBeenCalled();
    });
    it("refuses API-key / bearer clients: the kit is not part of the API or MCP surface", async () => {
        for (const h of [{"x-api-key": "k"}, {authorization: "Bearer abc"}]) {
            const r = await POST(mk(h), ctx("paper"));
            expect(r.status).toBe(403);
            expect(await r.json()).toMatchObject({code: "forbidden"});
        }
        expect(gen).not.toHaveBeenCalled();
    });
    it("404 for flags off and for an unknown kind", async () => {
        mode.mockResolvedValue({mode: "off"});
        expect((await POST(mk(), ctx("paper"))).status).toBe(404);
        mode.mockResolvedValue({mode: "on"});
        expect((await POST(mk(), ctx("../etc"))).status).toBe(404);
    });
    it("success: no-store headers, nothing else is cacheable, the kit is the body", async () => {
        gen.mockResolvedValue({ok: true, kind: "paper", contentType: "text/html", body: "<html>KIT</html>", nonce: "n"});
        const r = await POST(mk(), ctx("paper"));
        expect(r.status).toBe(200);
        expect(r.headers.get("cache-control")).toMatch(/no-store/);
        expect(r.headers.get("pragma")).toBe("no-cache");
        expect(r.headers.get("referrer-policy")).toBe("no-referrer");
        expect(r.headers.get("x-robots-tag")).toMatch(/noindex/);
        expect(await r.json()).toEqual({kind: "paper", html: "<html>KIT</html>"});
        gen.mockResolvedValue({ok: true, kind: "digital", contentType: "text/plain", body: "PBKIT1\n..", filename: "k.pbkit"});
        const d = await POST(mk(), ctx("digital"));
        expect(d.headers.get("cache-control")).toMatch(/no-store/);
        expect(await d.json()).toEqual({kind: "digital", filename: "k.pbkit", file: "PBKIT1\n.."});
    });
    it("refusals map to stable statuses and no-store, never echo the input", async () => {
        const secret = "S3cretPassphrase-never-echo";
        for (const [code, status] of [["token_invalid", 410], ["weak_passphrase", 422], ["forbidden", 403], ["locked", 423], ["rate_limited", 429], ["unavailable", 503]] as const) {
            gen.mockResolvedValue({ok: false, code, message: "plain sentence"});
            const r = await POST(mk({}, {token: "t".repeat(30), passphrase: secret}), ctx("digital"));
            expect(r.status).toBe(status);
            expect(r.headers.get("cache-control")).toMatch(/no-store/);
            expect(JSON.stringify(await r.json())).not.toContain(secret);
        }
    });
    it("passes only the four expected fields to the service (nothing else from the body)", async () => {
        gen.mockResolvedValue({ok: false, code: "invalid_input", message: "x"});
        await POST(mk({}, {token: "a".repeat(30), passphrase: "p", passphraseConfirm: "p", isAdmin: true, kind: "paper"}), ctx("digital"));
        expect(Object.keys(gen.mock.calls[0][1]).sort()).toEqual(["kind", "passphrase", "passphraseConfirm", "token"]);
        expect(gen.mock.calls[0][1].kind).toBe("digital"); // the URL decides, not the body
    });
});
