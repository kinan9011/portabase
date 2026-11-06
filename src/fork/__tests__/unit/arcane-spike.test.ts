import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";

/**
 * W03 guards for the Arcane spike artefacts in `dev/fork-lab/arcane/` (pinned spec, capability map, scrubbed fixtures,
 * spike script) and `scripts/fork/arcane-openapi-diff.sh`. Source/data checks only (no Docker, no network): the live
 * behaviour is what `spike.sh` observed against the lab Arcane (results in `spike-results.json`, ADR-002 in the vault).
 */
const ROOT = process.cwd();
const DIR = path.join(ROOT, "dev/fork-lab/arcane");
const FIXTURES = path.join(ROOT, "src/fork/arcane/__fixtures__"); // moved here in W05
const DIFF = path.join(ROOT, "scripts/fork/arcane-openapi-diff.sh");
const json = (f: string) => JSON.parse(readFileSync(path.join(DIR, f), "utf8"));
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON documents of the pinned spec / spike output
type Json = any;
const must = <T,>(v: T | null | undefined, what: string): T => {
    if (v === null || v === undefined) throw new Error(`missing: ${what}`);
    return v;
};
const specFile = must(readdirSync(DIR).find((f) => /^openapi\.v[\d.]+\.json$/.test(f)), "pinned spec");
const spec = json(specFile);
const caps = json("capability-map.json");
const results = json("spike-results.json");
const fixtures = readdirSync(FIXTURES);
const script = readFileSync(path.join(DIR, "spike.sh"), "utf8");

describe("pinned Arcane OpenAPI", () => {
    it("exists exactly once and matches its sha256 file", () => {
        expect(readdirSync(DIR).filter((f) => /^openapi\.v[\d.]+\.json$/.test(f))).toHaveLength(1);
        const [hash, name] = readFileSync(path.join(DIR, `${specFile}.sha256`), "utf8").trim().split(/\s+/);
        expect(name).toBe(specFile);
        expect(createHash("sha256").update(readFileSync(path.join(DIR, specFile))).digest("hex")).toBe(hash);
        expect(results.openapi_sha256).toBe(`sha256:${hash}`);
    });

    it("is OpenAPI 3.x, versioned like its file name, with API-key auth", () => {
        expect(spec.openapi).toMatch(/^3\./);
        expect(specFile).toBe(`openapi.v${spec.info.version}.json`);
        expect(caps.arcane_version).toBe(spec.info.version);
        expect(results.arcane_version).toBe(spec.info.version);
        expect(spec.components.securitySchemes.ApiKeyAuth).toMatchObject({type: "apiKey", in: "header", name: "X-API-Key"});
    });

    it("contains no secret-looking material (a public spec must stay public)", () => {
        const text = readFileSync(path.join(DIR, specFile), "utf8");
        expect(text).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
        expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./);
    });
});

describe("capability map ↔ pinned spec", () => {
    const ops = new Map<string, Json>();
    for (const [p, item] of Object.entries<Json>(spec.paths))
        for (const m of ["get", "post", "put", "patch", "delete"]) if (item[m]) ops.set(`${m.toUpperCase()} ${p}`, item[m]);

    it("every capability exists in the spec with the recorded response schema", () => {
        for (const c of caps.capabilities) {
            const op = ops.get(`${c.method} ${c.path}`);
            expect(op, `${c.id}: ${c.method} ${c.path} missing from the spec`).toBeDefined();
            const ref = op.responses?.["200"]?.content?.["application/json"]?.schema?.$ref as string | undefined;
            expect(ref?.split("/").pop(), `${c.id}: response schema`).toBe(c.response_schema);
        }
    });

    it("capability ids are unique", () => {
        const ids = caps.capabilities.map((c: Json) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("only GET is used by the fork (tiers 1, 2, never); POST is tier 'unused'", () => {
        for (const c of caps.capabilities) {
            if (c.tier === "unused") expect(c.method, c.id).not.toBe("GET");
            else expect(c.method, c.id).toBe("GET");
        }
    });

    it("minimum key = list permissions only, no *:read/write, and every grant is in the spec's permission catalogue", () => {
        const catalogue = new Set<string>(json("permission-catalogue.json").flatMap((r: Json) => r.permissions));
        for (const g of caps.minimum_key.grants) {
            expect(catalogue.has(g.permission), g.permission).toBe(true);
            expect(g.permission).toMatch(/:list$/);
        }
        for (const g of caps.minimum_key.optional_deep) expect(catalogue.has(g.permission)).toBe(true);
        for (const n of caps.minimum_key.never.filter((x: string) => !x.endsWith("*"))) expect(catalogue.has(n), n).toBe(true);
    });

    it("tier-1 capabilities require exactly a permission of the minimum key (or none)", () => {
        const granted = new Set(caps.minimum_key.grants.map((g: Json) => g.permission));
        for (const c of caps.capabilities.filter((x: Json) => x.tier === 1)) {
            const perm = String(c.permission).split(" ")[0];
            if (perm === "none") continue;
            expect(granted.has(perm), `${c.id} needs ${perm}`).toBe(true);
        }
    });

    it("every tier-1/2 capability proven in the lab has an ok spike result or a matrix entry", () => {
        const okIds = new Set(results.capabilities.filter((r: Json) => r.ok).map((r: Json) => r.capability));
        const matrix = json("permission-matrix.json");
        const allowed = new Set(matrix.flatMap((m: Json) => m.allows));
        for (const c of caps.capabilities) {
            if (c.proof === "unverified" || c.proof.startsWith("spike pin") || c.proof.startsWith("lab.sh")) continue;
            expect(okIds.has(c.proof) || allowed.has(c.proof), `${c.id} proof ${c.proof}`).toBe(true);
        }
    });

    it("the permission matrix matches the map: *:read permissions that expose secrets are marked never", () => {
        const matrix = json("permission-matrix.json");
        const allows = (perm: string) => matrix.find((m: Json) => m.permission === perm).allows as string[];
        expect(allows("volumes:read")).toContain("vol.workspace.file");
        expect(allows("containers:read")).toContain("cont.edit-config");
        expect(allows("projects:read")).toContain("proj.workspace.file");
        for (const never of ["containers.get", "volumes.get", "volumes.workspace.file", "projects.workspace.file"])
            expect(caps.capabilities.find((c: Json) => c.id === never).tier).toBe("never");
        // tier-1 permissions alone must never reach secret-returning endpoints
        for (const perm of caps.minimum_key.grants.map((g: Json) => g.permission)) {
            const row = matrix.find((m: Json) => m.permission === perm);
            for (const bad of ["cont.get", "cont.edit-config", "vol.get", "vol.workspace.file", "proj.compose", "proj.workspace.file"])
                expect(row?.allows ?? [], `${perm} → ${bad}`).not.toContain(bad);
        }
    });

    it("the exposure probes recorded what the ADR claims, and the minimum key leaks nothing", () => {
        const x = results.exposure;
        expect(x.tier1_container_list_contains_env_value).toBe(false);
        expect(x.tier1_project_workspace_status).toBe(403);
        expect(x.tier1_volume_get_status).toBe(403);
        expect(x.projects_read_workspace_file_path_traversal_status).toBe(403);
        // documented exposures of the non-minimum permissions (these are why they are tier 2 / never)
        expect(x.projects_read_compose_services_contain_env_value).toBe(true);
        expect(x.containers_read_inspect_returns_env_value).toBe(true);
        expect(x.volumes_read_workspace_file_returns_bytes).toBe(true);
    });

    it("a key can introspect its own permissions (W05 self-test) and /auth/me reports the owner, not the key", () => {
        const x = results.exposure;
        expect(x.tier1_key_own_permissions_via_auth_me_api_keys).toEqual(
            caps.minimum_key.grants
                .map((g: Json) => (g.scope === "environment" ? `${g.permission}@0` : g.permission))
                .sort(),
        );
        expect(x.tier1_auth_me_reports_owner_is_global_admin).toBe(true);
    });

    it("remote environment: verified, scoped both ways, listing works with a tier-1 key scoped to the remote id", () => {
        const r = results.remote_environment;
        expect(r.verified).toBe(true);
        expect(r.remote_scoped_key_list_calls).toMatch(/^containers=200\(\d+\) volumes=200\(\d+\) networks=200\(\d+\) images=200\(\d+\) projects=200\(\d+\)$/);
        expect(r.remote_scoped_key_on_local_env.status).toBe(403);
        expect(r.local_scoped_key_on_remote_env_status).toBe(403);
    });

    it("401 / 403 behaviour was observed; the read-only key cannot POST", () => {
        const p = results.probes;
        expect([p.no_key, p.invalid_key]).toEqual([401, 401]);
        expect(p.forbidden_project_get_with_tier1.status).toBe(403);
        expect(p.forbidden_project_get_with_tier1.detail).toBe("permission denied: projects:read");
        expect(p.read_only_key_POST_environment_test).toBe(403);
    });
});

describe("scrubbed fixtures", () => {
    const text = fixtures.map((f) => [f, readFileSync(path.join(FIXTURES, f), "utf8")] as const);
    const labSecrets = readFileSync(path.join(ROOT, "dev/fork-lab/demo-stack/stack.env"), "utf8")
        .split("\n")
        .filter((l) => /^(POSTGRES_PASSWORD|APP_GREETING)=/.test(l))
        .map((l) => l.split("=").slice(1).join("="))
        .filter(Boolean);

    it("has the seed set W05 needs", () => {
        for (const f of ["environments", "projects", "containers", "volumes", "networks", "images"].map((n) => `${n}.list.json`))
            expect(fixtures).toContain(f);
    });

    it("parses, and has no env values, secrets, tokens, home paths or non-documentation IPs", () => {
        expect(labSecrets.length).toBeGreaterThan(0);
        for (const [f, t] of text) {
            expect(() => JSON.parse(t), f).not.toThrow();
            for (const s of labSecrets) expect(t.includes(s), `${f} contains a lab env value`).toBe(false);
            expect(t, f).not.toMatch(/\/home\/|\/Users\//);
            expect(t, f).not.toMatch(/"\$schema"/);
            expect(t, f).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.|X-API-Key|arc_[A-Za-z0-9]{16,}/i);
            for (const ip of t.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) expect(ip, `${f}: ${ip}`).toBe("192.0.2.1");
        }
    });

    it("keeps only forklab-* resources (the host's other containers, volumes and networks never enter git)", () => {
        const c = JSON.parse(must(text.find(([f]) => f === "containers.list.json"), "containers fixture")[1]);
        for (const x of c.data) expect(x.names.join(","), "container").toMatch(/forklab-demo/);
        for (const f of ["volumes.list.json", "networks.list.json"]) {
            const d = JSON.parse(must(text.find(([n]) => n === f), f)[1]);
            for (const x of d.data) expect(x.name, f).toMatch(/^forklab/);
        }
    });

    it("compose fixture has no service environment (names or values)", () => {
        const t = must(text.find(([f]) => f === "project.compose.json"), "compose fixture")[1];
        for (const s of JSON.parse(t).data.services) expect(s.environment).toBeUndefined();
    });
});

describe("spike.sh static guards", () => {
    it("is loopback-only with no bypass flag", () => {
        expect(script).toMatch(/http:\/\/127\.0\.0\.1:\*\|http:\/\/localhost:\*/);
        expect(script).not.toMatch(/ALLOW_HOST/);
        const r = spawnSync("bash", [path.join(DIR, "spike.sh"), tmpdir()], {env: {...process.env, ARCANE_URL: "http://example.com:3552"}, encoding: "utf8"});
        expect(r.status).toBe(2);
        expect(r.stderr).toMatch(/loopback/);
    });

    it("remote-env.sh (lab setup) is loopback-only and never writes the agent token to disk", () => {
        const re = readFileSync(path.join(DIR, "remote-env.sh"), "utf8");
        const r = spawnSync("bash", [path.join(DIR, "remote-env.sh")], {env: {...process.env, ARCANE_URL: "http://example.com:3552"}, encoding: "utf8"});
        expect(r.status).toBe(2);
        expect(re).not.toMatch(/>\s*\S*token|tee |echo[^\n]*AGENT_KEY/i);
        expect(re).toMatch(/LAB_ARCANE_AGENT_TOKEN="\$AGENT_KEY" docker compose/);
    });

    it("sends only GET with a scoped key; the admin bearer is confined to admin_call", () => {
        const admin = must(script.match(/admin_call\(\) \{[\s\S]*?\n\}/), "admin_call")[0];
        const apiGet = must(script.match(/api_get\(\) \{[\s\S]*?\n\}/), "api_get")[0];
        expect(apiGet).not.toMatch(/-X |Authorization|--data/);
        const rest = script.replace(admin, "");
        expect(rest.match(/Authorization: Bearer/g)).toBeNull();
        // every `-X <verb>` outside admin_call is the single, deliberate negative probe (POST with the read-only key)
        expect([...rest.matchAll(/-X (\w+)/g)].map((m) => m[1])).toEqual(["POST"]);
        expect(rest).toMatch(/-H "X-API-Key: \$KEY1" "\$API\/environments\/\$ENV_ID\/test"/);
    });

    it("never prints or stores the lab secret value and deletes the keys it mints", () => {
        expect(script).not.toMatch(/echo[^\n]*\$SECRET|printf[^\n]*\$SECRET/);
        expect(script).toMatch(/trap cleanup EXIT/);
        expect(script).toMatch(/DELETE "\/api-keys\/\$id"/);
    });

    it("the minimum key grants list permissions only", () => {
        const tier1 = must(script.match(/TIER1=\$\(jq -sc[^\n]*/), "TIER1")[0];
        const perms = [...tier1.matchAll(/[GE] ([a-z-]+:[a-z]+)/g)].map((m) => m[1]);
        expect(perms.length).toBe(6);
        for (const p of perms) expect(p).toMatch(/:list$/);
    });
});

describe("arcane-openapi-diff.sh", () => {
    const run = (...args: string[]) => spawnSync("bash", [DIFF, ...args], {encoding: "utf8"});
    const specPath = path.join(DIR, specFile);
    const mutate = (fn: (s: Json) => void) => {
        const s = JSON.parse(JSON.stringify(spec));
        fn(s);
        const f = path.join(mkdtempSync(path.join(tmpdir(), "arcane-diff-")), "mut.json");
        writeFileSync(f, JSON.stringify(s));
        return f;
    };

    it("identical → 0", () => {
        const r = run(specPath, specPath);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/no structural change/);
    });

    it("prose / info.version only → 0", () => {
        const f = mutate((s) => {
            s.info.version = "9.9.9";
            s.paths["/health"].get.summary = "changed prose";
        });
        expect(run(specPath, f).status).toBe(0);
    });

    it("removed operation, added operation and changed schema → 1 and named", () => {
        const f = mutate((s) => {
            delete s.paths["/health"].get;
            s.paths["/zzz-new"] = {get: {responses: {200: {description: "x"}}}};
            s.components.schemas.VersionCheck.properties.newField = {type: "string"};
        });
        const r = run(specPath, f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/removed \(breaking\)[\s\S]*op GET \/health/);
        expect(r.stdout).toMatch(/added[\s\S]*op GET \/zzz-new/);
        expect(r.stdout).toMatch(/changed structure[\s\S]*schema VersionCheck/);
    });

    it("changed permission-bearing parameter on an operation → 1", () => {
        const f = mutate((s) => {
            s.paths["/environments/{id}/containers"].get.parameters.push({name: "extra", in: "query", schema: {type: "string"}});
        });
        const r = run(specPath, f);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/op GET \/environments\/\{id\}\/containers/);
    });

    it("bad usage / unreadable input → 2", () => {
        expect(run().status).toBe(2);
        expect(run(specPath, "/nonexistent.json").status).toBe(2);
    });
});
