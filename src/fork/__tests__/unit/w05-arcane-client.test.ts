import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it, vi} from "vitest";
import {ArcaneClient, type ArcaneClientOptions} from "@/fork/arcane/client";
import {ArcaneError, permissionFromDetail} from "@/fork/arcane/errors";
import {endpointPath, ENDPOINTS} from "@/fork/arcane/endpoints";
import {byComposeProject, DISCOVERY_PROVIDER_METHODS} from "@/fork/discovery/provider";
import {parseAllowlist} from "@/fork/net/guard";
import {TransportError, type PinnedRequestInit, type PinnedResponse} from "@/fork/net/pinned-request";

const fx = (n: string) => JSON.parse(readFileSync(path.join(process.cwd(), "src/fork/arcane/__fixtures__", n), "utf8"));
const FIX = {envs: fx("environments.list.json"), projects: fx("projects.list.json"), containers: fx("containers.list.json"), volumes: fx("volumes.list.json"), networks: fx("networks.list.json"), images: fx("images.list.json"), compose: fx("project.compose.json")};
const KEY = "arc_CANARYKEY_0123456789abcdef";
const json = (status: number, body: unknown, headers: PinnedResponse["headers"] = {}): PinnedResponse => ({status, headers, body: JSON.stringify(body)});

type Call = PinnedRequestInit;
async function client(handler: (c: Call, n: number) => PinnedResponse | Promise<PinnedResponse>, extra: Partial<ArcaneClientOptions> = {}) {
    const calls: Call[] = [];
    const sleeps: number[] = [];
    const c = await ArcaneClient.create({
        baseUrl: "https://arcane.example.com/sub", apiKey: KEY, resolve: async () => [{address: "93.184.216.34", family: 4}],
        sleep: async (ms) => { sleeps.push(ms); },
        transport: async (i) => { calls.push(i); return handler(i, calls.length); }, ...extra,
    });
    return {c, calls, sleeps};
}

describe("DiscoveryProvider interface", () => {
    it("exposes exactly the scoped method set, all implemented by the Arcane client", () => {
        expect([...DISCOVERY_PROVIDER_METHODS]).toEqual(["listEnvironments", "testEnvironment", "listProjects", "readProjectFiles", "listContainers", "listVolumes", "listNetworks", "listImages"]);
        for (const m of DISCOVERY_PROVIDER_METHODS) expect(typeof (ArcaneClient.prototype as unknown as Record<string, unknown>)[m]).toBe("function");
    });
});

describe("endpoints — GET-only, allow-listed", () => {
    it("builds only the declared paths; ids are validated against path injection", () => {
        expect(endpointPath("containers", {id: "0"})).toBe("/api/environments/0/containers");
        expect(endpointPath("projectCompose", {id: "e1", projectId: "p-1"})).toBe("/api/environments/e1/projects/p-1/compose");
        for (const bad of ["../x", "a/b", "a?b", "", "x".repeat(65), "a b", "%2e%2e"]) expect(() => endpointPath("containers", {id: bad})).toThrow();
        expect(() => endpointPath("containers", {})).toThrow("missing identifier");
    });
    it("forbidden secret-returning endpoints are not in the table", () => {
        const all = Object.values(ENDPOINTS).map((e) => e.template).join(" ");
        expect(all).not.toMatch(/workspace|edit-config|volumes\/\{|containers\/\{containerId|\/test/);
    });
});

describe("listing + parsing", () => {
    it("environments: apiUrl never survives, ids/names/status do", async () => {
        const {c, calls} = await client(() => json(200, FIX.envs));
        const envs = await c.listEnvironments();
        expect(envs.map((e) => e.id)).toContain("0");
        expect(JSON.stringify(envs)).not.toContain("lab-arcane.invalid");
        expect(JSON.stringify(envs)).not.toContain("apiUrl");
        expect(calls[0].path).toBe("/api/environments?limit=100&start=0");
        expect(calls[0].headers).toEqual({"x-api-key": KEY});
        expect(calls[0].target.ip).toBe("93.184.216.34"); // pinned address handed to the transport
    });
    it.each([
        ["listProjects", "projects", "/api/environments/0/projects"],
        ["listContainers", "containers", "/api/environments/0/containers"],
        ["listVolumes", "volumes", "/api/environments/0/volumes"],
        ["listNetworks", "networks", "/api/environments/0/networks"],
        ["listImages", "images", "/api/environments/0/images"],
    ] as const)("%s parses the pinned-version fixture", async (method, key, p) => {
        const {c, calls} = await client(() => json(200, FIX[key]));
        const rows = await c[method]("0");
        expect(rows.length).toBe(FIX[key].data.length);
        expect(calls[0].path.startsWith(p + "?limit=100&start=0")).toBe(true);
    });
    it("containers: labels/mounts/networks kept, addresses and unknown fields dropped; compose-project filter works", async () => {
        const {c} = await client(() => json(200, FIX.containers));
        const cs = await c.listContainers("0");
        const first = cs[0];
        expect(first.labels["com.docker.compose.project"]).toBeTruthy();
        expect(first.mounts[0]).toEqual(expect.objectContaining({destination: expect.any(String), type: expect.any(String)}));
        expect(first.networks.every((n) => typeof n === "string")).toBe(true);
        expect(JSON.stringify(cs)).not.toMatch(/ipAddress|macAddress|endpointId|updateInfo|"command"/);
        const proj = first.labels["com.docker.compose.project"];
        expect(byComposeProject(cs, proj).every((x) => x.labels["com.docker.compose.project"] === proj)).toBe(true);
        expect(byComposeProject(cs, "does-not-exist")).toEqual([]);
    });
    it("CANARY: environment values in container/compose payloads never reach the DTOs (env dropped at the boundary)", async () => {
        const SECRET = "hunter2-CANARY-VALUE";
        const withEnv = {...FIX.containers, data: FIX.containers.data.map((d: object) => ({...d, config: {env: [`DB_PASSWORD=${SECRET}`]}, env: [`X=${SECRET}`], environment: {Y: SECRET}}))};
        const {c} = await client(() => json(200, withEnv));
        expect(JSON.stringify(await c.listContainers("0"))).not.toContain(SECRET);

        const comp = {...FIX.compose, data: {...FIX.compose.data, services: FIX.compose.data.services.map((s: object) => ({...s, environment: {DB_PASSWORD: SECRET, API_TOKEN: SECRET}}))}};
        const {c: c2} = await client(() => json(200, comp), {allowProjectsRead: true});
        const files = await c2.readProjectFiles("0", FIX.compose.data.id);
        expect(JSON.stringify(files.services)).not.toContain(SECRET);
        expect(files.services[0].environmentNames).toEqual(["DB_PASSWORD", "API_TOKEN"]);
        // list form `K=V` is reduced to names too
        const listForm = {...comp, data: {...comp.data, services: [{image: "x", environment: [`A=${SECRET}`, `B=${SECRET}`]}]}};
        const {c: c3} = await client(() => json(200, listForm), {allowProjectsRead: true});
        const f3 = await c3.readProjectFiles("0", FIX.compose.data.id);
        expect(f3.services[0].environmentNames).toEqual(["A", "B"]);
        expect(JSON.stringify(f3.services)).not.toContain(SECRET);
    });
    it("readProjectFiles needs the tier-2 opt-in and fails BEFORE any network call without it", async () => {
        const {c, calls} = await client(() => json(200, FIX.compose));
        await expect(c.readProjectFiles("0", "p1")).rejects.toMatchObject({errorClass: "permission", permission: "projects:read"});
        expect(calls).toHaveLength(0);
        const {c: c2, calls: calls2} = await client(() => json(200, FIX.compose), {allowProjectsRead: true});
        const f = await c2.readProjectFiles("0", FIX.compose.data.id);
        expect(f.composeContent.length).toBeGreaterThan(10);
        expect(calls2[0].path).toBe(`/api/environments/0/projects/${FIX.compose.data.id}/compose`);
    });
});

describe("pagination", () => {
    const item = (i: number) => ({id: `v${i}`, name: `vol-${i}`, driver: "local"});
    it("loops start += 100 until a short page", async () => {
        const {c, calls} = await client((req) => {
            const start = Number(/start=(\d+)/.exec(req.path)?.[1]);
            const n = start === 0 ? 100 : start === 100 ? 100 : 37;
            return json(200, {success: true, data: Array.from({length: n}, (_, i) => item(start + i)), pagination: {totalItems: 237}});
        });
        const vols = await c.listVolumes("0");
        expect(vols).toHaveLength(237);
        expect(calls.map((x) => /start=(\d+)/.exec(x.path)?.[1])).toEqual(["0", "100", "200"]);
        expect(calls.every((x) => x.path.includes("limit=100"))).toBe(true);
    });
    it("stops when totalItems is reached even on an exact multiple (no endless loop on a full last page)", async () => {
        const {c, calls} = await client((req) => {
            const start = Number(/start=(\d+)/.exec(req.path)?.[1]);
            return json(200, {data: start < 200 ? Array.from({length: 100}, (_, i) => item(start + i)) : [], pagination: {totalItems: 200}});
        });
        expect(await c.listVolumes("0")).toHaveLength(200);
        expect(calls).toHaveLength(2);
    });
    it("is bounded (a server that never ends is cut off with bad_response)", async () => {
        const {c} = await client((req) => json(200, {data: Array.from({length: 100}, (_, i) => item(Number(/start=(\d+)/.exec(req.path)?.[1]) + i))}));
        await expect(c.listVolumes("0")).rejects.toMatchObject({errorClass: "bad_response"});
    });
});

describe("error mapping", () => {
    it("401 → invalid_key; 403 → permission with the exact permission name; 404 → not_found", async () => {
        expect(await (await client(() => json(401, {detail: "invalid API key"}))).c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "invalid_key", status: 401, health: "auth_failed"});
        const e403 = await (await client(() => json(403, {detail: "permission denied: containers:list"}))).c.listContainers("0").catch((e: ArcaneError) => e);
        expect(e403).toMatchObject({errorClass: "permission", permission: "containers:list", health: "degraded"});
        expect((e403 as Error).message).toContain("containers:list");
        expect(await (await client(() => json(404, {}))).c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "not_found"});
    });
    it("403 detail is only surfaced when strictly shaped (no injection of arbitrary server text)", () => {
        expect(permissionFromDetail(JSON.stringify({detail: "permission denied: containers:list"}))).toBe("containers:list");
        expect(permissionFromDetail(JSON.stringify({detail: "permission denied: x; <script>"}))).toBeUndefined();
        expect(permissionFromDetail("not json")).toBeUndefined();
    });
    it("no retries on 4xx", async () => {
        const {c, calls, sleeps} = await client(() => json(401, {}));
        await c.listVolumes("0").catch(() => 0);
        expect(calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
    });
    it("5xx and network errors: 2 bounded retries with back-off, then unreachable", async () => {
        const a = await client(() => json(503, {}));
        expect(await a.c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "unreachable", status: 503, health: "unreachable"});
        expect(a.calls).toHaveLength(3);
        expect(a.sleeps).toEqual([250, 1000]);
        const b = await client(() => { throw new TransportError("timeout", "x"); });
        expect(await b.c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "unreachable"});
        expect(b.calls).toHaveLength(3);
    });
    it("recovers when a retry succeeds", async () => {
        const {c, calls} = await client((_r, n) => (n < 3 ? json(502, {}) : json(200, FIX.volumes)));
        expect((await c.listVolumes("0")).length).toBe(FIX.volumes.data.length);
        expect(calls).toHaveLength(3);
    });
    it("429 honours Retry-After (≤ 10 s) and retries; a longer one fails fast as rate_limited", async () => {
        const a = await client((_r, n) => (n === 1 ? json(429, {}, {"retry-after": "2"}) : json(200, FIX.volumes)));
        await a.c.listVolumes("0");
        expect(a.sleeps).toEqual([2000]);
        const b = await client(() => json(429, {}, {"retry-after": "60"}));
        expect(await b.c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "rate_limited", status: 429});
        expect(b.sleeps).toEqual([]);
        const c = await client(() => json(429, {}));
        expect(await c.c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "rate_limited"});
        expect(c.calls).toHaveLength(3);
    });
    it("tls → tls (no retry); redirect/oversize/non-JSON → bad_response; malformed body → bad_response", async () => {
        const t = await client(() => { throw new TransportError("tls", "x"); });
        expect(await t.c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "tls", health: "unreachable"});
        expect(t.calls).toHaveLength(1);
        for (const code of ["redirect", "too_large", "bad_content_type"] as const) {
            const r = await client(() => { throw new TransportError(code, "x"); });
            expect(await r.c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "bad_response"});
        }
        expect(await (await client(() => ({status: 200, headers: {}, body: "<<<"}))).c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "bad_response"});
        expect(await (await client(() => json(200, {data: [{nope: 1}]}))).c.listVolumes("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "bad_response"});
    });
    it("error text never carries the key, URL, query or response body", async () => {
        const body = {detail: "boom SECRETBODY", token: "SECRETBODY"};
        for (const status of [400, 401, 403, 404, 500, 429]) {
            const {c} = await client(() => json(status, body, {"retry-after": "99"}));
            const e = await c.listVolumes("0").catch((x: Error) => x);
            const text = `${(e as Error).message} ${JSON.stringify(e)}`;
            expect(text).not.toMatch(/SECRETBODY|arc_CANARYKEY|arcane\.example\.com|limit=100|start=/);
        }
    });
    it("a blocked URL fails at create() with blocked_url and never reaches the transport", async () => {
        const transport = vi.fn();
        for (const baseUrl of ["http://169.254.169.254", "https://127.0.0.1", "http://10.0.0.1:3552", "https://user:pw@arcane.example.com"]) {
            const e = await ArcaneClient.create({baseUrl, apiKey: KEY, transport}).catch((x: ArcaneError) => x);
            expect(e).toMatchObject({errorClass: "blocked_url", health: "unreachable"});
        }
        expect(transport).not.toHaveBeenCalled();
        // the lab case works with the documented allow-list
        const ok = await ArcaneClient.create({baseUrl: "http://127.0.0.1:13552", apiKey: KEY, allowlist: parseAllowlist("127.0.0.1"), transport: async () => json(200, FIX.volumes)});
        expect((await ok.listVolumes("0")).length).toBeGreaterThan(0);
    });
});

describe("testEnvironment (no POST /test)", () => {
    it("environment visible + scoped tier-1 list call succeeds → reachable", async () => {
        const {c, calls} = await client((req) => (req.path.includes("/containers") ? json(200, {data: [], pagination: {totalItems: 0}}) : json(200, FIX.envs)));
        expect(await c.testEnvironment("0")).toEqual({environmentId: "0", status: "online", reachable: true});
        expect(calls.map((x) => x.path.split("?")[0])).toEqual(["/api/environments", "/api/environments/0/containers"]);
    });
    it("unknown environment → not_found; unreachable remote (502 from Arcane) → unreachable; 403 → permission", async () => {
        const a = await client(() => json(200, FIX.envs));
        expect(await a.c.testEnvironment("nope").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "not_found"});
        const b = await client((req) => (req.path.includes("/containers") ? json(502, {detail: "Remote environment rejected the manager's credentials"}) : json(200, FIX.envs)));
        expect(await b.c.testEnvironment("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "unreachable", status: 502});
        const c = await client((req) => (req.path.includes("/containers") ? json(403, {detail: "permission denied: containers:list"}) : json(200, FIX.envs)));
        expect(await c.c.testEnvironment("0").catch((e: ArcaneError) => e)).toMatchObject({errorClass: "permission", permission: "containers:list"});
    });
});

describe("connection checks", () => {
    it("getVersion is unauthenticated (no key header) and accepts bare or wrapped payloads", async () => {
        const a = await client(() => json(200, {currentVersion: "2.17.3", updateAvailable: false}));
        expect(await a.c.getVersion()).toBe("2.17.3");
        expect(a.calls[0].headers).toEqual({});
        const b = await client(() => json(200, {data: {currentVersion: "2.17.3"}}));
        expect(await b.c.getVersion()).toBe("2.17.3");
        // the real lab answers `v2.17.3` (observed live, W05): the leading v must not break the pin check
        expect(await (await client(() => json(200, {currentVersion: "v2.17.3", updateAvailable: false}))).c.getVersion()).toBe("2.17.3");
    });
    it("listOwnerKeys parses permission grants", async () => {
        const {c} = await client(() => json(200, {success: true, data: [{id: "k1", name: "n", keyPrefix: "arc_abc", kind: "scoped", permissions: [{permission: "environments:list"}, {permission: "containers:list", environmentId: "0"}]}]}));
        const rows = await c.listOwnerKeys();
        expect(rows[0].permissions).toEqual([{permission: "environments:list", environmentId: null}, {permission: "containers:list", environmentId: "0"}]);
    });
});
