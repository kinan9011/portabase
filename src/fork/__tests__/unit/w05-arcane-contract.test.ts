import {createHash} from "node:crypto";
import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {API_PREFIX, ARCANE_PINNED_VERSION, ENDPOINTS, ENV_MINIMUM, GLOBAL_MINIMUM, TIER2_PERMISSION} from "@/fork/arcane/endpoints";
import {ApiKeyRow, ComposeResponse, ContainerItem, EnvironmentItem, ImageItem, NetworkItem, page, ProjectItem, VolumeItem} from "@/fork/arcane/schemas";

/**
 * Contract tests against the PINNED Arcane OpenAPI (v2.17.3, ADR-002 A1) and the scrubbed lab fixtures. They prove: every
 * request the client can make exists as a GET in the spec with the permission/tier recorded in the capability map; every
 * field the allow-list schemas read exists in the pinned response schemas; fixtures satisfy the spec's `required` keys and
 * parse. A spec bump (`scripts/fork/arcane-openapi-diff.sh`) that moves any of this turns these red.
 */
const DIR = path.join(process.cwd(), "dev/fork-lab/arcane");
const FIX = path.join(process.cwd(), "src/fork/arcane/__fixtures__");
const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
// biome-ignore lint/suspicious/noExplicitAny: parsed OpenAPI document
type J = any;
const specFile = readdirSync(DIR).find((f) => /^openapi\.v[\d.]+\.json$/.test(f)) as string;
const spec: J = json(path.join(DIR, specFile));
const caps: J = json(path.join(DIR, "capability-map.json"));
const catalogue: J[] = json(path.join(DIR, "permission-catalogue.json"));
const schemas: J = spec.components.schemas;

const resolve = (s: J): J => (s?.$ref ? resolve(schemas[s.$ref.split("/").pop() as string]) : s);
/** properties of the (paginated or wrapped) response's `data` item schema */
const dataProps = (respName: string): {props: J; required: string[]} => {
    const root = resolve(schemas[respName]);
    const data = resolve(root.properties.data);
    const item = resolve(data.items ?? data);
    return {props: item.properties, required: item.required ?? []};
};
const cap = (id: string): J => {
    const c = caps.capabilities.find((x: J) => x.id === id);
    if (!c) throw new Error(`capability ${id} missing`);
    return c;
};
const permissionNames = new Set<string>(catalogue.flatMap((r) => r.permissions));

describe("pinned spec ↔ client", () => {
    it("the pinned version constant, the spec file name/hash and the capability map agree", () => {
        expect(spec.info.version).toBe(ARCANE_PINNED_VERSION);
        expect(specFile).toBe(`openapi.v${ARCANE_PINNED_VERSION}.json`);
        expect(caps.arcane_version).toBe(ARCANE_PINNED_VERSION);
        const [hash] = readFileSync(path.join(DIR, `${specFile}.sha256`), "utf8").trim().split(/\s+/);
        expect(createHash("sha256").update(readFileSync(path.join(DIR, specFile))).digest("hex")).toBe(hash);
        expect(API_PREFIX).toBe(new URL(spec.servers[0].url).pathname);
    });

    it.each(Object.entries(ENDPOINTS))("%s: GET %s exists in the spec, same path/tier as the capability map", (_name, e) => {
        const c = cap(e.cap);
        expect(c.method).toBe("GET");
        expect(c.path).toBe(e.template);
        expect(c.tier).toBe(e.tier);
        expect(Object.keys(spec.paths[e.template])).toContain("get");
        expect(c.permission).toBeTruthy();
    });

    it("forbidden / write capabilities are not reachable: no ENDPOINTS template equals a never/unused capability path", () => {
        const ours = new Set(Object.values(ENDPOINTS).map((e) => `GET ${e.template}`));
        for (const c of caps.capabilities.filter((x: J) => x.tier === "never" || x.tier === "unused")) expect(ours.has(`${c.method} ${c.path}`), c.id).toBe(false);
    });

    it("minimum-key constants equal the capability map's minimum grants and are real Arcane permission names", () => {
        const g = caps.minimum_key.grants as {permission: string; scope: string}[];
        expect(g.filter((x) => x.scope === "global").map((x) => x.permission)).toEqual([...GLOBAL_MINIMUM]);
        expect(g.filter((x) => x.scope === "environment").map((x) => x.permission)).toEqual([...ENV_MINIMUM]);
        expect(caps.minimum_key.optional_deep.map((x: J) => x.permission)).toEqual([TIER2_PERMISSION]);
        for (const p of [...GLOBAL_MINIMUM, ...ENV_MINIMUM, TIER2_PERMISSION]) expect(permissionNames.has(p), p).toBe(true);
        // the list-only minimum contains no *:read / write class
        for (const p of [...GLOBAL_MINIMUM, ...ENV_MINIMUM]) expect(p).toMatch(/:list$/);
    });

    it("the permission recorded for every tier-1 list capability is the one the key policy grants", () => {
        const byPath: Record<string, string> = {
            "projects.list": "projects:list", "containers.list": "containers:list", "volumes.list": "volumes:list", "networks.list": "networks:list", "images.list": "images:list",
        };
        for (const [id, perm] of Object.entries(byPath)) expect(cap(id).permission).toBe(perm);
        expect(cap("environments.list").permission).toContain("environments:list");
    });
});

describe("allow-list schemas ⊆ pinned response schemas; fixtures conform", () => {
    const cases: [string, string, {shape: Record<string, unknown>; safeParse: (v: unknown) => {success: boolean}}, string][] = [
        ["environments.list", "environments.list.json", EnvironmentItem, "environments"],
        ["projects.list", "projects.list.json", ProjectItem, "projects"],
        ["containers.list", "containers.list.json", ContainerItem, "containers"],
        ["volumes.list", "volumes.list.json", VolumeItem, "volumes"],
        ["networks.list", "networks.list.json", NetworkItem, "networks"],
        ["images.list", "images.list.json", ImageItem, "images"],
    ];
    it.each(cases)("%s: every key the adapter reads exists in %s's spec schema; fixture items satisfy the spec's required keys and parse", (id, file, schema) => {
        const {props, required} = dataProps(cap(id).response_schema);
        const mine = Object.keys(schema.shape);
        for (const k of mine) expect(Object.keys(props), `${id}.${k}`).toContain(k);
        const fx = json(path.join(FIX, file));
        for (const item of fx.data) {
            for (const r of required) expect(Object.keys(item), `${id} required ${r}`).toContain(r);
            expect(schema.safeParse(item).success, `${id} fixture item`).toBe(true);
        }
    });
    it("container mounts / network settings keys read by the adapter exist in the spec", () => {
        const {props} = dataProps(cap("containers.list").response_schema);
        const mount = resolve(resolve(props.mounts).items).properties;
        for (const k of ["type", "name", "source", "destination", "rw"]) expect(Object.keys(mount), `mounts.${k}`).toContain(k);
        expect(Object.keys(resolve(props.hostConfig).properties)).toEqual(expect.arrayContaining(["privileged", "networkMode"]));
        expect(Object.keys(resolve(props.networkSettings).properties)).toContain("networks");
    });
    it("page envelopes: pagination keys the adapter reads exist; list responses carry `data` + `pagination`", () => {
        const root = resolve(schemas[cap("containers.list").response_schema]);
        expect(Object.keys(root.properties)).toEqual(expect.arrayContaining(["data", "pagination"]));
        const pag = Object.keys(resolve(root.properties.pagination).properties);
        for (const k of ["currentPage", "itemsPerPage", "totalItems", "totalPages"]) expect(pag).toContain(k);
    });
    it("API key rows: the self-test reads id/keyPrefix/kind/permissions[{permission,environmentId}] — all in the spec", () => {
        const {props, required} = dataProps(cap("auth.me.api-keys").response_schema);
        for (const k of Object.keys(ApiKeyRow.shape)) expect(Object.keys(props), k).toContain(k);
        expect(required).toEqual(expect.arrayContaining(["id", "keyPrefix", "permissions"]));
        const grant = resolve(resolve(props.permissions).items).properties;
        expect(Object.keys(grant).sort()).toEqual(["environmentId", "permission"]);
    });
    it("compose (tier 2): fields read exist in the spec; fixture parses and `environment` VALUES are not part of any adapter type", () => {
        const {props} = dataProps(cap("projects.compose").response_schema);
        for (const k of ["id", "composeContent", "composeFileName", "overrideContent", "overrideFileName", "services"]) expect(Object.keys(props), k).toContain(k);
        const parsed = ComposeResponse.safeParse(json(path.join(FIX, "project.compose.json")));
        expect(parsed.success).toBe(true);
        expect(JSON.stringify(parsed.success ? parsed.data : {})).not.toContain("\"environment\":");
    });
    it("the page() helper accepts the fixture envelope of every list", () => {
        for (const [, file, schema] of cases) expect(page(schema as never).safeParse(json(path.join(FIX, file))).success, file).toBe(true);
    });
});
