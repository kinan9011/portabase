import {describe, expect, it} from "vitest";
import {checkForkCsrf, forkCsrfGuard} from "@/fork/route-guard";

const env = {PROJECT_URL: "https://pb.example.test"};
const req = (method: string, headers: Record<string, string> = {}, url = "https://pb.example.test/api/fork/x", body?: string) =>
    new Request(url, {method, headers, body});
const json = {"content-type": "application/json"};

describe("SEC-16 CSRF guard for /api/fork/*", () => {
    it("safe methods pass without any header", () => {
        for (const m of ["GET", "HEAD", "OPTIONS"]) expect(checkForkCsrf(req(m), env)).toEqual({ok: true});
    });
    it("same-origin POST (Sec-Fetch-Site or matching Origin) with JSON passes", () => {
        expect(checkForkCsrf(req("POST", {...json, "sec-fetch-site": "same-origin"}, undefined, "{}"), env).ok).toBe(true);
        expect(checkForkCsrf(req("POST", {...json, origin: "https://pb.example.test"}, undefined, "{}"), env).ok).toBe(true);
        expect(checkForkCsrf(req("DELETE", {origin: "https://pb.example.test"}), env).ok).toBe(true); // no body, no content-type
    });
    it("Sec-Fetch-Site: none (user-initiated navigation/typed URL) is not cross-site", () => {
        expect(checkForkCsrf(req("POST", {...json, "sec-fetch-site": "none"}, undefined, "{}"), env).ok).toBe(true);
    });
    it.each(["cross-site", "same-site"])("Sec-Fetch-Site: %s is refused (even with a matching Origin)", (v) => {
        expect(checkForkCsrf(req("POST", {...json, "sec-fetch-site": v, origin: "https://pb.example.test"}, undefined, "{}"), env)).toEqual({ok: false, reason: "cross-site"});
    });
    it("foreign Origin is refused; look-alike origins are refused", () => {
        for (const o of ["https://evil.test", "https://pb.example.test.evil.test", "http://pb.example.test", "null", "not a url"])
            expect(checkForkCsrf(req("POST", {...json, origin: o}, undefined, "{}"), env), o).toEqual({ok: false, reason: "origin-mismatch"});
    });
    it("no Origin and no Sec-Fetch-Site ⇒ refused", () => {
        expect(checkForkCsrf(req("POST", json, undefined, "{}"), env)).toEqual({ok: false, reason: "no-origin"});
    });
    it("form-style content types are refused (classic CSRF vector)", () => {
        for (const ct of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain"])
            expect(checkForkCsrf(req("POST", {"content-type": ct, "sec-fetch-site": "same-origin"}, undefined, "a=b"), env), ct).toEqual({ok: false, reason: "content-type"});
    });
    it("origin of the request URL is accepted when PROJECT_URL is unset", () => {
        expect(checkForkCsrf(req("POST", {...json, origin: "https://pb.example.test"}, undefined, "{}"), {}).ok).toBe(true);
    });
    it("the guard returns a generic 403 JSON and null when allowed", async () => {
        const denied = forkCsrfGuard(req("POST", {...json, origin: "https://evil.test"}, undefined, "{}"), env)!;
        expect(denied.status).toBe(403);
        expect(JSON.stringify(await denied.json())).not.toMatch(/origin|evil/i);
        expect(forkCsrfGuard(req("GET"), env)).toBeNull();
    });
});
