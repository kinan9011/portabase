import {readFileSync} from "node:fs";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {ArcaneClient} from "@/fork/arcane/client";
import {verifyConnection} from "@/fork/arcane/connection-service";
import {ENV_MINIMUM} from "@/fork/arcane/endpoints";
import {evaluateKeyPermissions} from "@/fork/arcane/key-policy";
import {byComposeProject} from "@/fork/discovery/provider";
import {parseAllowlist} from "@/fork/net/guard";

/**
 * LIVE test against the disposable lab Arcane (`dev/fork-lab`, loopback only). Skipped unless FORK_LAB=1:
 *   cd dev/fork-lab && ./lab.sh up        # or: docker compose --env-file .env.lab -f compose.arcane.yml up -d arcane
 *   FORK_LAB=1 pnpm test:fork arcane-live
 * The lab ADMIN login is used ONLY to mint/delete scoped keys (writes against the lab, never the adapter); every adapter call
 * is a GET through the real client + pinned transport + SSRF guard (`127.0.0.1` allow-listed explicitly).
 */
const LAB = process.env.FORK_LAB === "1"; // captured at load: setup-unit clears FORK_* env after each test
const URL_ = process.env.ARCANE_URL ?? "http://127.0.0.1:13552";
const ADMIN_USER = process.env.LAB_ARCANE_ADMIN_USER ?? "arcane";
const ADMIN_PASS = process.env.LAB_ARCANE_ADMIN_PASSWORD ?? "arcane-admin";
const allowlist = parseAllowlist("127.0.0.1");
const g = (permission: string) => ({permission});
const e = (permission: string, environmentId = "0") => ({permission, environmentId});
const MIN = () => [g("environments:list"), ...ENV_MINIMUM.map((p) => e(p))];

describe.skipIf(!LAB)("arcane-live — adapter vs lab Arcane v2.17.3", () => {
    let token = "";
    const minted: string[] = [];
    const api = async (method: string, p: string, body?: unknown, bearer = token) => {
        const r = await fetch(`${URL_}/api${p}`, {method, headers: {"content-type": "application/json", authorization: `Bearer ${bearer}`}, body: body ? JSON.stringify(body) : undefined});
        return {status: r.status, json: (await r.json().catch(() => ({}))) as {data?: {id?: string; key?: string}}};
    };
    const mint = async (name: string, permissions: unknown[]) => {
        const r = await api("POST", "/api-keys", {name: `forklab-w05-${name}`, description: "W05 live test, lab only", permissions});
        if (r.status !== 200 || !r.json.data?.key) throw new Error(`key mint failed (${r.status})`);
        minted.push(r.json.data.id as string);
        return r.json.data.key;
    };
    const client = (apiKey: string, o: Parameters<typeof ArcaneClient.create>[0] extends infer T ? Partial<T> : never = {}) => ArcaneClient.create({baseUrl: URL_, apiKey, allowlist, ...o});

    beforeAll(async () => {
        expect(["127.0.0.1", "localhost"]).toContain(new globalThis.URL(URL_).hostname); // lab only, never a real Arcane
        for (let i = 0; i < 2 && !token; i++) {
            const r = await fetch(`${URL_}/api/auth/login`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({username: ADMIN_USER, password: ADMIN_PASS})});
            if (r.status === 429) { await new Promise((res) => setTimeout(res, (Number(r.headers.get("retry-after")) || 60) * 1000)); continue; }
            token = ((await r.json()) as {data?: {token?: string}}).data?.token ?? "";
        }
        if (!token) throw new Error("lab admin login failed (lab Arcane up? default admin unchanged?)");
        const old = await api("GET", "/api-keys?limit=200");
        for (const k of (old.json.data as unknown as {id: string; name: string}[]) ?? []) if (k.name?.startsWith("forklab-w05-")) await api("DELETE", `/api-keys/${k.id}`);
    }, 150_000);
    afterAll(async () => { for (const id of minted) await api("DELETE", `/api-keys/${id}`).catch(() => undefined); });

    it("version matches the pinned contract; key self-test finds OUR row by keyPrefix among the owner's keys and accepts the minimum", async () => {
        const key = await mint("min", MIN());
        await mint("sibling-broad", [...MIN(), e("containers:read")]); // another key of the same owner: listed too, must be ignored
        const c = await client(key);
        expect(await c.getVersion()).toBe("2.17.3"); // the lab answers "v2.17.3"; the adapter normalises
        const rows = await c.listOwnerKeys();
        const ev = evaluateKeyPermissions(rows, key, {allowProjectsRead: false});
        expect(ev).toMatchObject({ok: true, keyId: minted[0], environmentIds: ["0"], partial: false}); // own row = the first minted key, found by keyPrefix
        expect(rows.length).toBeGreaterThanOrEqual(2);
    }, 60_000);

    it("verifyConnection (the save/test core) = healthy against the lab, GET only", async () => {
        const key = await mint("verify", MIN());
        const v = await verifyConnection({allowlist}, {baseUrl: URL_, apiKey: key, tlsInsecure: false, allowProjectsRead: false});
        expect(v).toMatchObject({ok: true, state: "healthy", errorClass: null, version: "2.17.3"});
        expect(v.environments).toEqual([{externalId: "0", name: expect.any(String), reachable: true, errorClass: null}]);
        expect(v.warnings.join(" ")).toContain("allow-list"); // loopback was permitted by the operator allow-list, visibly
    }, 60_000);

    it("lists environments/projects/containers/volumes/networks/images; apiUrl and env values never surface; host-wide lists filter by compose project", async () => {
        const c = await client(await mint("lists", MIN()));
        const envs = await c.listEnvironments();
        expect(envs.map((x) => x.id)).toContain("0");
        expect(JSON.stringify(envs)).not.toMatch(/apiUrl|http:\/\//);
        const [projects, containers, volumes, networks, images] = await Promise.all([c.listProjects("0"), c.listContainers("0"), c.listVolumes("0"), c.listNetworks("0"), c.listImages("0")]);
        expect(projects.map((p) => p.name)).toContain("forklab-demo");
        const demo = byComposeProject(containers, "forklab-demo");
        expect(demo.length).toBeGreaterThan(0);
        expect(demo[0].mounts.length).toBeGreaterThan(0);
        expect(volumes.length).toBeGreaterThan(0);
        expect(networks.length).toBeGreaterThan(0);
        expect(images.some((i) => i.repoDigests.length > 0)).toBe(true);
        const all = JSON.stringify({projects, containers, volumes, networks, images});
        const stackEnv = readFileSync(path.join(process.cwd(), "dev/fork-lab/demo-stack/stack.env"), "utf8");
        for (const line of stackEnv.split("\n")) {
            const val = line.split("=").slice(1).join("=").trim();
            if (val.length >= 8) expect(all).not.toContain(val); // synthetic secret values of the demo stack
        }
        expect(await c.testEnvironment("0")).toMatchObject({environmentId: "0", reachable: true});
    }, 60_000);

    it("pagination with the lab's real server: limit=100 offset loop returns every volume", async () => {
        const c = await client(await mint("page", MIN()));
        const volumes = await c.listVolumes("0");
        const raw = await fetch(`${URL_}/api/environments/0/volumes?limit=1000`, {headers: {"x-api-key": await mint("page2", MIN())}});
        const total = ((await raw.json()) as {data: unknown[]}).data.length;
        expect(volumes.length).toBe(total);
    }, 60_000);

    it("key policy against REAL grants: containers:read ⇒ key_too_broad; global containers:list ⇒ refused; projects:read needs the opt-in", async () => {
        const broad = await mint("broad", [...MIN(), e("containers:read")]);
        const v = await verifyConnection({allowlist}, {baseUrl: URL_, apiKey: broad, tlsInsecure: false, allowProjectsRead: false});
        expect(v).toMatchObject({ok: false, errorClass: "key_too_broad", extraPermissions: ["containers:read"]});
        const glob = await mint("global", [g("environments:list"), g("containers:list"), ...ENV_MINIMUM.filter((p) => p !== "containers:list").map((p) => e(p))]);
        expect(await verifyConnection({allowlist}, {baseUrl: URL_, apiKey: glob, tlsInsecure: false, allowProjectsRead: false})).toMatchObject({ok: false, errorClass: "key_too_broad"});
        const t2 = await mint("tier2", [...MIN(), e("projects:read")]);
        expect(await verifyConnection({allowlist}, {baseUrl: URL_, apiKey: t2, tlsInsecure: false, allowProjectsRead: false})).toMatchObject({ok: false, errorClass: "key_too_broad"});
        expect(await verifyConnection({allowlist}, {baseUrl: URL_, apiKey: t2, tlsInsecure: false, allowProjectsRead: true})).toMatchObject({ok: true, state: "healthy"});
    }, 60_000);

    it("tier 2 (opt-in): compose text + env NAMES only — the demo stack's env VALUES never leave the adapter", async () => {
        const key = await mint("deep", [...MIN(), e("projects:read")]);
        const c = await client(key, {allowProjectsRead: true});
        const demo = (await c.listProjects("0")).find((p) => p.name === "forklab-demo");
        expect(demo).toBeTruthy();
        const files = await c.readProjectFiles("0", demo!.id);
        expect(files.composeContent).toContain("services:");
        const stackEnv = readFileSync(path.join(process.cwd(), "dev/fork-lab/demo-stack/stack.env"), "utf8");
        const dump = JSON.stringify(files.services);
        for (const line of stackEnv.split("\n")) {
            const val = line.split("=").slice(1).join("=").trim();
            if (val.length >= 8) expect(dump).not.toContain(val);
        }
        const noOptIn = await client(key);
        await expect(noOptIn.readProjectFiles("0", demo!.id)).rejects.toMatchObject({errorClass: "permission"});
    }, 60_000);

    it("error mapping against real status codes: invalid key → 401 invalid_key; env-scoped key on another environment → 403 permission with the exact name", async () => {
        const bad = await client("arc_0000000000000000000000000000000000000000");
        await expect(bad.listVolumes("0")).rejects.toMatchObject({errorClass: "invalid_key", status: 401});
        const envEnvs = (await api("GET", "/environments")).json as unknown as {data: {id: string}[]};
        const other = envEnvs.data.find((x) => x.id !== "0");
        const key = await mint("scoped", MIN());
        const c = await client(key);
        if (other) await expect(c.listVolumes(other.id)).rejects.toMatchObject({errorClass: "permission", status: 403});
        await expect(c.listVolumes("does-not-exist-env")).rejects.toMatchObject({errorClass: expect.stringMatching(/permission|not_found|bad_response|unreachable/)});
    }, 60_000);

    it("default deny holds live: without the allow-list the lab (127.0.0.1) is refused before any request", async () => {
        const v = await verifyConnection({allowlist: parseAllowlist("")}, {baseUrl: URL_, apiKey: "arc_x_xxxxxxxxxxxxxxxxxxxx", tlsInsecure: false, allowProjectsRead: false});
        expect(v).toMatchObject({ok: false, errorClass: "blocked_url", state: "unreachable"});
    });
});
