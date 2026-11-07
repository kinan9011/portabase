import {describe, expect, it} from "vitest";
import {CANARY, richInventory} from "@/fork/__tests__/w08-fixtures";
import {InventoryViewSchema, safeImageRef, toInventoryView} from "@/fork/stacks/dto";
import {escapeLike, isFiltered, PAGE_SIZE, parseStackListParams, toQueryString} from "@/fork/stacks/params";

const meta = {version: 3, capturedAt: new Date("2026-11-07T01:00:05Z")};

describe("W08 DTO mapper: allow-list, never the raw inventory", () => {
    it("maps the lab-shaped inventory (services, volumes, binds, anonymous, databases, networks, shared flags)", () => {
        const v = toInventoryView(richInventory(), meta)!;
        expect(v.version).toBe(3);
        expect(v.services.map((s) => `${s.name}:${s.state}`)).toEqual(["db:running", "web:running"]);
        expect(v.volumes.map((x) => x.name)).toEqual(["forklab-demo_appdata", "forklab-demo_pgdata"]);
        expect(v.binds).toEqual([{destination: "/app/uploads", hostPath: "/srv/lab/demo/uploads", rw: false, consumers: ["web"], ownership: "unknown"}]);
        expect(v.anonymousVolumes).toEqual([{destination: "/var/cache", consumers: ["web"], rw: true}]);
        expect(v.databases).toEqual([{service: "db", engine: "postgresql", basis: "image"}]);
        expect(v.networks.find((n) => n.name === "lab_proxy")).toMatchObject({classification: "shared_external", external: true, members: ["web"]});
        expect(v.shared).toEqual([{kind: "network", name: "lab_proxy"}]);
        expect(v.warnings.map((w) => w.code)).toContain("network-shared-external");
    });
    it("does not carry env names, container ids, provenance, source, hints (only a count of env names)", () => {
        const v = toInventoryView(richInventory(), meta)!;
        const json = JSON.stringify(v);
        for (const leaked of ["POSTGRES_PASSWORD", "APP_SECRET", "POSTGRES_USER", "abcdef123456", "fedcba654321", "openapi", "arcane_list", "/srv/lab/demo/compose.yml", "working_dir", "provenance", "connection_id"]) expect(json).not.toContain(leaked);
        expect(v.services[0].envCount).toBe(2);
        expect(() => InventoryViewSchema.parse({...v, extra: 1})).toThrow(); // strict: nothing can be smuggled in
    });
    it("a planted canary in unknown fields is refused by parsing (no DTO) and never copied", () => {
        const inv: any = richInventory();
        inv.services[0].env = {SECRET: CANARY};
        expect(toInventoryView(inv, meta)).toBeNull();
        const ok: any = richInventory();
        ok.stack.display_name = "plain";
        expect(JSON.stringify(toInventoryView(ok, meta))).not.toContain(CANARY);
    });
    it("unreadable / unknown-major / garbage stored values → null, never throws", () => {
        for (const bad of [null, undefined, 5, "x", [], {}, {schema_version: 2}, {...richInventory(), schema_version: 9}]) expect(toInventoryView(bad, meta)).toBeNull();
    });
    it("strips registry credentials from an image reference", () => {
        expect(safeImageRef("user:hunter2@registry.example.com/app:1")).toBe("registry.example.com/app:1");
        expect(safeImageRef("user@registry.example.com/app:1")).toBe("registry.example.com/app:1");
        expect(safeImageRef("nginx@sha256:" + "a".repeat(64))).toBe("nginx@sha256:" + "a".repeat(64));
        expect(safeImageRef("ghcr.io/o/i@sha256:" + "a".repeat(64))).toBe("ghcr.io/o/i@sha256:" + "a".repeat(64));
        const inv = richInventory();
        inv.services[1].image.ref = "ci:tok3n@registry.example.com/web:1";
        expect(JSON.stringify(toInventoryView(inv, meta))).not.toContain("tok3n");
    });
});

describe("W08 list params: untrusted URL input", () => {
    it("defaults for nothing / garbage", () => {
        expect(parseStackListParams({})).toEqual({q: "", environment: null, runtime: null, protection: null, sort: "name", page: 1});
        expect(parseStackListParams({runtime: "bogus", protection: "x", sort: "drop table", page: "-4"})).toMatchObject({runtime: null, protection: null, sort: "name", page: 1});
        expect(parseStackListParams({page: "NaN"}).page).toBe(1);
        expect(parseStackListParams({page: "99999999"}).page).toBeLessThanOrEqual(10_000);
    });
    it("accepts the closed sets, takes the first of repeated params, bounds and cleans text", () => {
        expect(parseStackListParams({runtime: ["partial", "running"], protection: "paused", sort: "attention", page: "3"})).toMatchObject({runtime: "partial", protection: "paused", sort: "attention", page: 3});
        const p = parseStackListParams({q: `${"a".repeat(500)}\u0000\u001f `, environment: "e".repeat(500)});
        expect(p.q.length).toBe(100);
        expect(p.q).not.toMatch(/[\u0000-\u001f]/);
        expect(p.environment!.length).toBe(128);
    });
    it("escapes LIKE metacharacters", () => expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b"));
    it("isFiltered / toQueryString round trip (defaults omitted)", () => {
        expect(isFiltered(parseStackListParams({}))).toBe(false);
        expect(isFiltered(parseStackListParams({q: "x"}))).toBe(true);
        expect(toQueryString({q: "a b", sort: "name", page: 1})).toBe("?q=a+b");
        expect(toQueryString({runtime: "running", page: 2, sort: "updated"})).toBe("?runtime=running&sort=updated&page=2");
        expect(toQueryString({})).toBe("");
        expect(PAGE_SIZE).toBe(25);
    });
});
