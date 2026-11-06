import {execFileSync} from "node:child_process";
import {mkdtempSync, readFileSync} from "node:fs";
import http from "node:http";
import https from "node:https";
import type {AddressInfo} from "node:net";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {parseAllowlist, vetBaseUrl, type Resolver} from "@/fork/net/guard";
import {pinnedGet, TransportError} from "@/fork/net/pinned-request";

const listen = (srv: http.Server | https.Server) => new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
const close = (srv: http.Server | https.Server) => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
const allow = parseAllowlist("127.0.0.1");
const target = async (url: string, resolve?: Resolver) => vetBaseUrl(url, {allowlist: allow, resolve});
const errCode = (p: Promise<unknown>) => p.then(() => "ok", (e: TransportError) => (e instanceof TransportError ? e.code : `other:${e}`));

let plain: http.Server;
let plainPort: number;
const seen: {host?: string; path?: string; headers?: http.IncomingHttpHeaders; method?: string}[] = [];
let tls: https.Server;
let tlsPort: number;
let certPem = "";

beforeAll(async () => {
    plain = http.createServer((req, res) => {
        seen.push({host: req.headers.host, path: req.url, headers: req.headers, method: req.method});
        const u = req.url ?? "";
        if (u.startsWith("/api/redirect")) { res.writeHead(302, {location: "http://169.254.169.254/latest"}); return res.end(); }
        if (u.startsWith("/api/html")) { res.writeHead(200, {"content-type": "text/html"}); return res.end("<html>"); }
        if (u.startsWith("/api/big")) { res.writeHead(200, {"content-type": "application/json"}); return res.end("x".repeat(5000)); }
        if (u.startsWith("/api/slow")) return; // never answers
        if (u.startsWith("/api/403")) { res.writeHead(403, {"content-type": "application/json"}); return res.end(JSON.stringify({detail: "permission denied: containers:list"})); }
        res.writeHead(200, {"content-type": "application/json"});
        res.end(JSON.stringify({ok: true}));
    });
    plainPort = await listen(plain);

    const dir = mkdtempSync(path.join(os.tmpdir(), "w05-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", "/CN=arcane.test", "-addext", "subjectAltName=DNS:arcane.test"], {stdio: "ignore"});
    certPem = readFileSync(path.join(dir, "c.pem"), "utf8");
    tls = https.createServer({key: readFileSync(path.join(dir, "k.pem")), cert: certPem}, (_req, res) => {
        res.writeHead(200, {"content-type": "application/json"});
        res.end("{\"tls\":true}");
    });
    tlsPort = await listen(tls);
});
afterAll(async () => { await close(plain); await close(tls); });

describe("pinnedGet — pinning, no redirects, limits", () => {
    it("GET only, sends caller headers, joins the base path, speaks to the pinned IP", async () => {
        const t = await target(`http://127.0.0.1:${plainPort}/base`);
        const r = await pinnedGet({target: t, path: "/api/environments?limit=100", headers: {"x-api-key": "k"}});
        expect(r.status).toBe(200);
        expect(JSON.parse(r.body)).toEqual({ok: true});
        const last = seen.at(-1);
        expect(last).toMatchObject({path: "/base/api/environments?limit=100", method: "GET"});
        expect(last?.headers?.["x-api-key"]).toBe("k");
    });

    it("DNS rebinding: resolves ONCE; a name whose second answer would be metadata still connects to the vetted address", async () => {
        let calls = 0;
        const resolve: Resolver = async () => (++calls === 1 ? [{address: "127.0.0.1", family: 4}] : [{address: "169.254.169.254", family: 4}]);
        const t = await target(`http://rebind.example.test:${plainPort}`, resolve);
        const before = seen.length;
        for (let i = 0; i < 3; i++) expect((await pinnedGet({target: t, path: "/api/ping"})).status).toBe(200);
        expect(calls).toBe(1);
        expect(seen.length - before).toBe(3);
        expect(seen.at(-1)?.host).toBe(`rebind.example.test:${plainPort}`); // Host header keeps the name
    });

    it("the connection really goes to target.ip even when the name resolves elsewhere in the system resolver", async () => {
        // `unresolvable.invalid` can not resolve; the request only works because the lookup is forced to the vetted address.
        const t = await target(`http://unresolvable.invalid:${plainPort}`, async () => [{address: "127.0.0.1", family: 4}]);
        expect((await pinnedGet({target: t, path: "/api/ping"})).status).toBe(200);
    });

    it("refuses every redirect (cross-host redirect to metadata is never followed)", async () => {
        const t = await target(`http://127.0.0.1:${plainPort}`);
        const before = seen.length;
        expect(await errCode(pinnedGet({target: t, path: "/api/redirect"}))).toBe("redirect");
        expect(seen.length - before).toBe(1);
    });

    it("2xx must be JSON; error statuses are returned for the caller to map", async () => {
        const t = await target(`http://127.0.0.1:${plainPort}`);
        expect(await errCode(pinnedGet({target: t, path: "/api/html"}))).toBe("bad_content_type");
        const r = await pinnedGet({target: t, path: "/api/403"});
        expect(r.status).toBe(403);
        expect(r.body).toContain("permission denied: containers:list");
    });

    it("size cap and total deadline", async () => {
        const t = await target(`http://127.0.0.1:${plainPort}`);
        expect(await errCode(pinnedGet({target: t, path: "/api/big", maxBytes: 1000}))).toBe("too_large");
        const t0 = Date.now();
        expect(await errCode(pinnedGet({target: t, path: "/api/slow", timeoutMs: 150}))).toBe("timeout");
        expect(Date.now() - t0).toBeLessThan(3000);
    });

    it("connection refused → network (generic message, no host/port/path in it)", async () => {
        const dead = http.createServer();
        const port = await listen(dead);
        await close(dead);
        const t = await target(`http://127.0.0.1:${port}/secret-path`);
        const e = await pinnedGet({target: t, path: "/api/x?api_key=SECRETQ"}).then(() => null, (x: Error) => x);
        expect(e).toBeInstanceOf(TransportError);
        expect((e as TransportError).code).toBe("network");
        expect((e as Error).message).not.toMatch(/127\.0\.0\.1|secret-path|SECRETQ|\d{4,5}/);
    });

    it("never logs headers or bodies (console + stdout/stderr spy)", async () => {
        const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info"), vi.spyOn(console, "debug")];
        const out = vi.spyOn(process.stdout, "write");
        const err = vi.spyOn(process.stderr, "write");
        const t = await target(`http://127.0.0.1:${plainPort}`);
        await pinnedGet({target: t, path: "/api/ping", headers: {"x-api-key": "CANARY_KEY_123"}});
        await pinnedGet({target: t, path: "/api/403", headers: {"x-api-key": "CANARY_KEY_123"}});
        const all = [...spies, out, err].flatMap((s) => s.mock.calls.map((c) => String(c[0]))).join("\n");
        expect(all).not.toContain("CANARY_KEY_123");
        for (const s of [...spies, out, err]) s.mockRestore();
    });
});

describe("pinnedGet — TLS", () => {
    it("verification is ON: a self-signed certificate is refused (class tls)", async () => {
        const t = await vetBaseUrl(`https://arcane.test:${tlsPort}`, {allowlist: allow, resolve: async () => [{address: "127.0.0.1", family: 4}]});
        expect(await errCode(pinnedGet({target: t, path: "/api/x"}))).toBe("tls");
    });
    it("explicit per-connection opt-out accepts it", async () => {
        const t = await vetBaseUrl(`https://arcane.test:${tlsPort}`, {allowlist: allow, resolve: async () => [{address: "127.0.0.1", family: 4}]});
        const r = await pinnedGet({target: t, path: "/api/x", tlsInsecure: true});
        expect(JSON.parse(r.body)).toEqual({tls: true});
    });
    it("hostname verification uses the original name, not the pinned IP (cert for arcane.test fails for other.test)", async () => {
        const t = await vetBaseUrl(`https://other.test:${tlsPort}`, {allowlist: allow, resolve: async () => [{address: "127.0.0.1", family: 4}]});
        expect(await errCode(pinnedGet({target: t, path: "/api/x"}))).toBe("tls");
    });
});
