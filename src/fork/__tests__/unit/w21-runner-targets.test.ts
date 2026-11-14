import {describe, expect, it} from "vitest";
import {RunnerProbePayload} from "@/fork/runner/payload-schema";
import {configOf, endpointOf, materialize, parseAdminTargets, targetsSha, type AdminTarget} from "@/fork/runner/targets";

const admin = (o: Partial<AdminTarget> = {}): AdminTarget => ({kind: "tcp", host: "10.20.30.40", port: 25, class: "smtp", label: "Prod SMTP", ...o});
const noDns = async () => [] as string[];

describe("parseAdminTargets", () => {
    it("accepts IP literals, hostnames and dns_name entries with a label", () => {
        const r = parseAdminTargets([admin(), admin({host: "mail.example.org", label: "Mail"}), {kind: "dns_name", host: "db.example.org", class: "database", label: "DB name"}, {kind: "dns_tcp", host: "10.20.30.53", port: 53, class: "dns", label: "Resolver"}]);
        expect(Array.isArray(r) && r.length).toBe(4);
    });
    it.each([
        ["loopback", admin({host: "127.0.0.1"})], ["unspecified", admin({host: "0.0.0.0"})], ["link-local", admin({host: "169.254.1.1"})], ["multicast", admin({host: "224.1.1.1"})], ["v6 loopback", admin({host: "::1"})],
        ["a URL", admin({host: "http://10.0.0.1"})], ["userinfo", admin({host: "user@10.0.0.1"})], ["a path", admin({host: "10.0.0.1/x"})], ["uppercase hostname", admin({host: "Mail.Example.org"})],
        ["no port", {kind: "tcp", host: "10.0.0.1", class: "smtp", label: "x"}], ["port 0", admin({port: 0})], ["bad label", admin({label: "<script>"})], ["empty label", admin({label: ""})],
        ["bad class", {...admin(), class: "dashboard"}], ["unknown field", {...admin(), extra: 1}], ["dns_tcp with a hostname", {kind: "dns_tcp", host: "ns.example.org", port: 53, class: "dns", label: "x"}],
        ["dns_name with a port", {kind: "dns_name", host: "db.example.org", port: 5432, class: "database", label: "x"}],
    ])("refuses %s", (_n, t) => expect(parseAdminTargets([t])).toBe("target_invalid"));
    it("refuses a non-array and more than 24 entries", () => {
        expect(parseAdminTargets("x")).toBe("target_invalid");
        expect(parseAdminTargets(Array.from({length: 25}, () => admin()))).toBe("too_many_targets");
        expect(Array.isArray(parseAdminTargets(Array.from({length: 24}, () => admin())))).toBe(true);
    });
});

describe("configOf + the sha", () => {
    const base = {serverUrl: "https://dash.example.org", arcaneUrls: ["https://arcane.example.org:8443", "https://arcane.example.org:8443", "http://10.1.1.1"], admin: [admin()]};
    it("is canonical: de-duplicates and sorts arcane endpoints, ignores key order, and defaults ports", () => {
        const a = configOf(base);
        expect(a.config.server).toEqual({host: "dash.example.org", port: 443});
        expect(a.config.arcane).toEqual([{host: "10.1.1.1", port: 80}, {host: "arcane.example.org", port: 8443}]);
        expect(configOf({...base, arcaneUrls: [...base.arcaneUrls].reverse()}).sha256).toBe(a.sha256);
        expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
    it("changes when any input changes (this is what makes `targets_changed` deterministic)", () => {
        const a = configOf(base).sha256;
        expect(configOf({...base, admin: [admin({port: 26})]}).sha256).not.toBe(a);
        expect(configOf({...base, admin: []}).sha256).not.toBe(a);
        expect(configOf({...base, serverUrl: "https://other.example.org"}).sha256).not.toBe(a);
        expect(configOf({...base, arcaneUrls: []}).sha256).not.toBe(a);
    });
    it("endpointOf handles v6 brackets, defaults and junk", () => {
        expect(endpointOf("http://[2001:db8::1]:8080/x")).toEqual({host: "2001:db8::1", port: 8080});
        expect(endpointOf("ftp://x")).toBeNull();
        expect(endpointOf("nope")).toBeNull();
    });
});

describe("materialize", () => {
    it("builds ids t01.., always includes the DNS canary, and resolves hostnames to tcp + dns_name targets", async () => {
        const {config} = configOf({serverUrl: "https://dash.example.org", arcaneUrls: [], admin: [admin({host: "mail.example.org", label: "Mail"})]});
        const resolve = async (h: string) => (h === "dash.example.org" ? ["10.9.9.9"] : h === "mail.example.org" ? ["10.8.8.8", "10.8.8.9"] : []);
        const m = await materialize(config, resolve);
        expect(m.ok).toBe(true);
        if (!m.ok) return;
        expect(m.targets.map((t) => t.id)).toEqual(m.targets.map((_, i) => `t${String(i + 1).padStart(2, "0")}`));
        expect(m.targets.filter((t) => t.kind === "tcp").map((t) => `${t.host}:${t.port}`).sort()).toEqual(["10.8.8.8:25", "10.8.8.9:25", "10.9.9.9:443"]);
        expect(m.targets.filter((t) => t.kind === "dns_name").map((t) => t.host).sort()).toEqual(["dash.example.org", "example.com", "mail.example.org"]);
        expect(m.targets.find((t) => t.host === "example.com")?.class).toBe("dns");
        expect(RunnerProbePayload.safeParse({v: 1, probe_id: "99999999-9999-4999-8999-999999999999", targets_sha256: targetsSha(m.targets), timeout_ms: 1500, targets: m.targets.map(({id, kind, host, port}) => ({id, kind, host, ...(port !== undefined ? {port} : {})}))}).success).toBe(true);
    });
    it("silently skips an AUTO target that resolves only to loopback (reported as skipped) but refuses an ADMIN one", async () => {
        const loop = async () => ["127.0.0.1"];
        const auto = await materialize(configOf({serverUrl: "http://forklab-dashboard.localhost:3000", arcaneUrls: [], admin: []}).config, loop);
        expect(auto.ok && auto.skipped).toEqual([{class: "dashboard", label: "Dashboard", reason: "loopback"}]);
        expect(auto.ok && auto.targets.map((t) => t.host)).toEqual(["example.com"]);
        const refused = await materialize(configOf({serverUrl: "https://dash.example.org", arcaneUrls: [], admin: [admin({host: "localhost.example.org"})]}).config, loop);
        expect(refused).toEqual({ok: false, code: "target_invalid"});
    });
    it("de-duplicates by (kind, host, port) and refuses more than 32 targets", async () => {
        const dup = await materialize(configOf({serverUrl: "https://10.0.0.1", arcaneUrls: [], admin: [admin({host: "10.0.0.1", port: 443, class: "custom", label: "same"})]}).config, noDns);
        expect(dup.ok && dup.targets.filter((t) => t.host === "10.0.0.1")).toHaveLength(1);
        const many = Array.from({length: 24}, (_, i) => admin({host: `10.0.${i}.1`}));
        const arcane = Array.from({length: 12}, (_, i) => `https://10.1.${i}.1`);
        expect(await materialize(configOf({serverUrl: "https://10.2.0.1", arcaneUrls: arcane, admin: many}).config, noDns)).toEqual({ok: false, code: "too_many_targets"});
    });
    it("a resolver failure never fails the request: the name stays a dns_name target only", async () => {
        const m = await materialize(configOf({serverUrl: "https://dash.example.org", arcaneUrls: [], admin: []}).config, async () => { throw new Error("boom"); });
        expect(m.ok && m.skipped).toEqual([{class: "dashboard", label: "Dashboard", reason: "loopback"}]);
    });
    it("targetsSha depends on id, kind, host and port (not on class or label)", async () => {
        const m = await materialize(configOf({serverUrl: "https://10.0.0.1", arcaneUrls: [], admin: []}).config, noDns);
        if (!m.ok) throw new Error("x");
        const a = targetsSha(m.targets);
        expect(targetsSha(m.targets.map((t) => ({...t, label: "changed", class: "custom" as const})))).toBe(a);
        expect(targetsSha(m.targets.map((t) => ({...t, host: t.host === "10.0.0.1" ? "10.0.0.2" : t.host})))).not.toBe(a);
    });
});
