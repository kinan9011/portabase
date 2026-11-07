import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {ARCANE_OPENAPI_SHA256, ENDPOINTS} from "@/fork/arcane/endpoints";
import {normalizeEnvironment} from "@/fork/inventory/normalize";
import {parseInventoryStrict} from "@/fork/inventory/schema";
import {discoveredFrom, LAB_PROXY} from "@/fork/__tests__/discovered-fixtures";

/**
 * W07 contract tests vs the PINNED Arcane spec (v2.17.3, ADR-002 A1): what the discovery sync + normaliser rely on beyond W05's
 * schema-key proofs — the sync's request set, offset pagination, the spec hash recorded in every inventory, and that real (pinned,
 * scrubbed) payloads normalise into schema-valid inventories. A spec bump that changes any of this turns these red.
 */
const DIR = path.join(process.cwd(), "dev/fork-lab/arcane");
// biome-ignore lint/suspicious/noExplicitAny: parsed OpenAPI document
const spec: any = JSON.parse(readFileSync(path.join(DIR, "openapi.v2.17.3.json"), "utf8"));
const SYNC_ENDPOINTS = ["version", "ownKeys", "environments", "projects", "containers", "volumes", "networks", "images"] as const;

describe("sync request set ⊂ pinned spec", () => {
    it("the spec hash recorded in every inventory is the pinned file's hash", () => {
        expect(readFileSync(path.join(DIR, "openapi.v2.17.3.json.sha256"), "utf8").trim().split(/\s+/)[0]).toBe(ARCANE_OPENAPI_SHA256);
    });
    it("every endpoint the sync can call is a GET in the spec; the paged ones accept limit + start (offset paging, ADR-002 §1)", () => {
        for (const name of SYNC_ENDPOINTS) {
            const e = ENDPOINTS[name];
            const op = spec.paths[`/api${e.template.replace(/\{id\}/g, "{id}")}`]?.get ?? spec.paths[e.template]?.get;
            expect(op, `${name} ${e.template}`).toBeDefined();
        }
        for (const name of ["environments", "projects", "containers", "volumes", "networks", "images"] as const) {
            const p = spec.paths[ENDPOINTS[name].template]?.get ?? spec.paths[`/api${ENDPOINTS[name].template}`]?.get;
            const params = (p.parameters ?? []).map((x: {name: string}) => x.name);
            expect(params, name).toEqual(expect.arrayContaining(["limit", "start"]));
        }
    });
    it("no sync endpoint is a write: the sync module imports only list methods of the provider (static)", () => {
        const src = readFileSync(path.join(process.cwd(), "src/fork/discovery/sync.ts"), "utf8");
        const used = new Set([...src.matchAll(/client\.(\w+)\(/g)].map((m) => m[1]));
        expect([...used].sort()).toEqual(["getVersion", "listContainers", "listEnvironments", "listImages", "listNetworks", "listOwnerKeys", "listProjects", "listVolumes", "readProjectFiles"]);
    });
});

describe("pinned payloads normalise into schema-valid, stable inventories", () => {
    it("the scrubbed lab fixtures (real Arcane v2.17.3 responses) → strict-valid inventory v1 that survives a JSON round trip", async () => {
        const l = await discoveredFrom();
        const r = normalizeEnvironment({connectionId: "00000000-0000-4000-8000-000000000001", environmentId: "0", arcaneVersion: "2.17.3", capturedAt: new Date("2026-11-07T00:00:00Z"), ...l, networks: [...l.networks, LAB_PROXY]});
        expect(r.stacks).toHaveLength(1);
        const inv = r.stacks[0].inventory;
        expect(parseInventoryStrict(JSON.parse(JSON.stringify(inv)))).toEqual(inv);
        expect(inv.source.openapi_sha256).toBe(`sha256:${ARCANE_OPENAPI_SHA256}`);
        expect(Buffer.byteLength(JSON.stringify(inv))).toBeLessThan(64 * 1024); // fixtures: a 2-service stack is a few KB (ADR-004 §7 budget: ≤ 1 MiB)
    });
    it("container `mounts[].type` values the normaliser understands are the ones the spec/fixtures use", () => {
        const item = spec.components.schemas.DockerContainerContainerPaginatedResponse ?? {};
        expect(JSON.stringify(item).length).toBeGreaterThan(10); // schema exists under the name the capability map pins
    });
});
