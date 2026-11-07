import {describe, expect, it} from "vitest";
import {validateCompleteness} from "@/fork/completeness";
import type {CompletenessContext, ProbeResult} from "@/fork/completeness/types";
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {planStack} from "@/fork/materialize/plan";
import {isAcceptableDbHost, isAdoptableVolumeName, SelectionSchema, VOLUME_NAME_RE, type Selection} from "@/fork/materialize/types";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {w10Inventory} from "@/fork/__tests__/w10-fixtures";

const sel = (o: Partial<Selection> = {}): Selection => SelectionSchema.parse(o);
/** Bypasses the schema on purpose: the planner must hold even if a caller hands it an unvalidated selection. */
const selRaw = (o: Partial<Selection>): Selection => ({...SelectionSchema.parse({}), ...o});
const M1 = "m:0000000000000001"; // named volume app_data
const M2 = "m:0000000000000002"; // bind /data/uploads

/** cleanInventory + a postgres service (named data volume + a second named volume for assets). */
function withDb(over: Partial<StackInventoryV1> = {}): StackInventoryV1 {
    const inv = w10Inventory();
    inv.services.push({name: "db", state: "running", image: {ref: "postgres:16", pinned: false, built_locally: false}, ports: [], networks: [], mounts: ["m:00000000000000a1"], env_keys: [], database_hint: {engine: "postgresql", basis: "image"}});
    inv.mounts.push({id: "m:00000000000000a1", kind: "named_volume", volume_name: "app_pgdata", destination: "/var/lib/postgresql/data", rw: true, consumers: ["db"], ownership: "stack_owned"});
    inv.volumes.push({name: "app_pgdata", driver: "local", in_use_by: ["db"], ownership: "stack_owned"});
    return {...inv, ...over};
}
const DUMP = {kind: "dump" as const, host: "demo-db", port: 5432, username: "demo", database: "demo"};

describe("W10 plan: mapping (wave §Scope)", () => {
    it("compose dir + env → ONE files source (snapshot default), bind → files, named volume → docker-volume", () => {
        const p = planStack(w10Inventory(), sel());
        expect(p.sources.map((s) => [s.role, s.dbms, s.engine, s.config])).toEqual([
            ["compose", "files", "restic", {path: "/srv/app"}],
            ["bind", "files", "archive", {path: "/data/uploads"}],
            ["volume", "docker-volume", "archive", {volume_name: "app_data"}],
        ]);
        const compose = p.sources[0];
        expect(compose.covers).toEqual(["file:/srv/app/compose.yml", "file:/srv/app/compose.override.yml", "env:/srv/app/stack.env", "env:implicit"]);
        expect(p.skipped).toEqual([]);
    });
    it("composeMethod archive is honoured", () => {
        expect(planStack(w10Inventory(), sel({composeMethod: "archive"})).sources[0].engine).toBe("archive");
    });
    it("never emits container_name or cron/retention-like keys in any config (D29, D33)", () => {
        const inv = withDb();
        const p = planStack(inv, sel({databases: {db: DUMP}}));
        for (const s of p.sources) {
            expect(Object.keys(s.config).sort().join()).not.toMatch(/container_name|cron|retention|backup_policy|password/);
        }
    });
    it("is deterministic and idempotent: same inputs → identical sources and planHash; order of input arrays does not matter", () => {
        const a = planStack(withDb(), sel({databases: {db: DUMP}}));
        const b = planStack(withDb(), sel({databases: {db: DUMP}, includeKeys: [], excludeKeys: []}));
        expect(a).toEqual(b);
        const inv = withDb();
        inv.volumes.reverse();
        expect(planStack(inv, sel({databases: {db: DUMP}})).planHash).toBe(a.planHash);
    });
    it("planHash changes when the inventory gains a resource (inventory drift) or the selection changes", () => {
        const base = planStack(w10Inventory(), sel());
        const inv = w10Inventory();
        inv.volumes.push({name: "extra_vol", driver: "local", in_use_by: ["web"], ownership: "stack_owned"});
        expect(planStack(inv, sel()).planHash).not.toBe(base.planHash);
        expect(planStack(w10Inventory(), sel({composeMethod: "archive"})).planHash).not.toBe(base.planHash);
    });
});

describe("W10 plan: bind mounts under the compose directory", () => {
    it("are covered THROUGH the compose directory source (no second source; works for single-file binds); explicit include gives them their own", () => {
        const nested = cleanInventory(); // bind /srv/app/uploads sits under working dir /srv/app
        const p = planStack(nested, sel());
        expect(p.sources.map((s) => s.role)).toEqual(["compose", "volume"]);
        expect(p.sources[0].covers).toContain(`mount:${M2}`);
        expect(p.coverage[`mount:${M2}`]).toBe("files");
        const own = planStack(nested, sel({includeKeys: [`mount:${M2}`]}));
        expect(own.sources.map((s) => s.role)).toEqual(["compose", "bind", "volume"]);
        expect(own.sources.find((s) => s.role === "compose")?.covers).not.toContain(`mount:${M2}`);
    });
    it("an excluded or denied nested bind is not silently added to the compose source", () => {
        const inv = cleanInventory();
        inv.services[0].backup_hints = {exclude: true};
        expect(planStack(inv, sel()).sources[0].covers).not.toContain(`mount:${M2}`);
        const sock = cleanInventory();
        sock.mounts[1] = {...sock.mounts[1], host_path_hint: "/srv/app/docker.sock"};
        const p = planStack(sock, sel());
        expect(p.sources[0].covers).not.toContain(`mount:${M2}`);
    });
    it("if the compose directory itself is refused, binds under it get sources of their own (or a skip reason)", () => {
        const p = planStack(cleanInventory(), sel(), ["/data"]); // working dir /srv/app outside the allowed roots
        expect(p.skipped).toContainEqual({key: "dir:/srv/app", reason: "bind_path_denied"});
        expect(p.sources.some((s) => s.role === "bind")).toBe(false);
        expect(p.skipped).toContainEqual({key: `mount:${M2}`, reason: "bind_path_denied"});
    });
});

describe("W10 plan: SEC-24 volume guard", () => {
    it("regex + hash-named rule", () => {
        for (const ok of ["app_data", "forklab-demo_appdata", "a1", "A.b-c_d"]) expect(isAdoptableVolumeName(ok), ok).toBe(true);
        for (const bad of ["/", "/etc", "/var/run", "/tmp/x", "..", "../x", "a", "", " x", "-x", "_x", ".x", "a b", "a/b", "a;b", "a\nb", "0".repeat(64), "f".repeat(64)]) expect(isAdoptableVolumeName(bad), JSON.stringify(bad)).toBe(false);
        expect(VOLUME_NAME_RE.test("/tmp/x")).toBe(false);
    });
    it.each([["/tmp/x"], ["/"], ["../etc"], ["a b"], ["0123456789abcdef".repeat(4)]])("a volume named %j in the inventory never becomes a docker-volume source", (name) => {
        const inv = w10Inventory();
        inv.volumes = [{name, driver: "local", in_use_by: ["web"], ownership: "stack_owned"}];
        const p = planStack(inv, sel());
        expect(p.sources.filter((s) => s.dbms === "docker-volume")).toEqual([]);
        expect(p.skipped.some((s) => s.key === `volume:${name}` && (s.reason === "volume_name_invalid" || s.reason === "anonymous_volume"))).toBe(true);
    });
    it("a named mount whose volume is not in the inventory is refused (existence rule)", () => {
        const inv = w10Inventory();
        inv.volumes = [];
        const p = planStack(inv, sel());
        expect(p.sources.some((s) => s.dbms === "docker-volume")).toBe(false);
        expect(p.skipped).toContainEqual({key: "volume:app_data", reason: "volume_not_in_inventory"});
    });
    it("external-shared and non-local-driver volumes are skipped with their reason", () => {
        const inv = w10Inventory();
        inv.volumes = [{name: "shared_vol", driver: "local", in_use_by: ["web"], ownership: "external_shared"}, {name: "nfs_vol", driver: "nfs", in_use_by: ["web"], ownership: "stack_owned"}];
        const p = planStack(inv, sel());
        expect(p.sources.filter((s) => s.dbms === "docker-volume")).toEqual([]);
        expect(p.skipped).toContainEqual({key: "volume:shared_vol", reason: "external_volume"});
        expect(p.skipped).toContainEqual({key: "volume:nfs_vol", reason: "unsupported_driver"});
    });
    it("anonymous volume mounts are never adopted (flagged by the validator instead)", () => {
        const inv = w10Inventory();
        inv.mounts.push({id: "m:00000000000000b1", kind: "anonymous_volume", destination: "/cache", rw: true, consumers: ["web"], ownership: "unknown"});
        const p = planStack(inv, sel());
        expect(p.skipped).toContainEqual({key: "mount:m:00000000000000b1", reason: "anonymous_volume"});
        expect(p.sources.some((s) => s.covers.includes("mount:m:00000000000000b1"))).toBe(false);
    });
});

describe("W10 plan: bind paths (never silently dropped)", () => {
    it.each([["/etc/app"], ["/var/run/docker.sock"], ["/"], ["/proc/1"], ["relative/path"]])("bind %s → no source, a skip reason (blocker stays visible in the validator)", (host) => {
        const inv = w10Inventory();
        inv.mounts[1] = {...inv.mounts[1], host_path_hint: host};
        const p = planStack(inv, sel());
        expect(p.sources.some((s) => s.role === "bind")).toBe(false);
        expect(p.skipped).toContainEqual({key: `mount:${M2}`, reason: "bind_path_denied"});
        const report = validateCompleteness(inv, {coverage: p.coverage, probes: {}, acceptedExclusions: [], allowedRoots: []});
        expect(report.complete).toBe(false);
    });
    it("a bind outside allowed_path_roots is refused; inside is accepted", () => {
        const inv = w10Inventory();
        expect(planStack(inv, sel(), ["/srv"]).skipped).toContainEqual({key: `mount:${M2}`, reason: "bind_path_denied"});
        expect(planStack(inv, sel(), ["/data", "/srv"]).sources.some((s) => s.role === "bind")).toBe(true);
    });
});

describe("W10 plan: databases (D29)", () => {
    it("postgres service + dump input → engine source with the operator's alias; password is only flagged as needed", () => {
        const p = planStack(withDb(), sel({databases: {db: DUMP}}));
        const db = p.sources.find((s) => s.role === "db");
        expect(db).toMatchObject({dbms: "postgresql", engine: "archive", config: {host: "demo-db", port: 5432, username: "demo", database: "demo"}, needsSecret: true, secretFor: "db", coverage: "engine_dump"});
        expect(JSON.stringify(db)).not.toMatch(/"password"/);
    });
    it("the DB's data volume is NOT also copied while a dump is selected, and counts as covered", () => {
        const p = planStack(withDb(), sel({databases: {db: DUMP}}));
        expect(p.sources.some((s) => s.dbms === "docker-volume" && (s.config as {volume_name: string}).volume_name === "app_pgdata")).toBe(false);
        expect(p.coverage["volume:app_pgdata"]).toBe("engine_dump");
        expect(p.coverage["db:db"]).toBe("engine_dump");
    });
    it("explicit includeKeys still copies the data volume too (explicit selection wins)", () => {
        const p = planStack(withDb(), sel({databases: {db: DUMP}, includeKeys: ["volume:app_pgdata"]}));
        expect(p.sources.some((s) => s.dbms === "docker-volume" && (s.config as {volume_name: string}).volume_name === "app_pgdata")).toBe(true);
    });
    it("no dump input → no DB source; the volume copy stays and the validator calls it file-copy-only (Partial, never Protected)", () => {
        const p = planStack(withDb(), sel());
        expect(p.skipped).toContainEqual({key: "db:db", reason: "db_not_selected"});
        expect(p.sources.some((s) => (s.config as {volume_name?: string}).volume_name === "app_pgdata")).toBe(true);
        const report = validateCompleteness(withDb(), {coverage: p.coverage, probes: {}, acceptedExclusions: [], allowedRoots: []});
        expect(report.fileCopyOnlyDatabases).toEqual(["db"]);
    });
    it("SQLite → upstream `sqlite` source with the operator's agent-visible path (D29); DB file covered by dump, volume not claimed", () => {
        const inv = withDb();
        inv.services[1].database_hint = {engine: "sqlite", basis: "mount"};
        const p = planStack(inv, sel({databases: {db: {kind: "sqlite", path: "/lab/sqlite/app.db"}}}));
        const s = p.sources.find((x) => x.role === "db");
        expect(s).toMatchObject({dbms: "sqlite", engine: "archive", config: {path: "/lab/sqlite/app.db"}, needsSecret: false, coverage: "engine_dump"});
        expect(p.coverage["volume:app_pgdata"]).toBe("files"); // still copied as a volume: sqlite `.backup` saves one file only
    });
    it.each([["/var/lib/docker/volumes/x_sqlite/_data/app.db"], ["/etc/app.db"], ["/"], ["rel.db"], ["/lab/../etc/x.db"]])("sqlite path %s is refused", (path) => {
        const inv = withDb();
        inv.services[1].database_hint = {engine: "sqlite", basis: "mount"};
        const p = planStack(inv, selRaw({databases: {db: {kind: "sqlite", path}}}));
        expect(p.sources.some((s) => s.dbms === "sqlite")).toBe(false);
        expect(p.skipped).toContainEqual({key: "db:db", reason: "db_input_invalid"});
    });
    it("a sqlite input for a postgres-hinted service, a dump input for a sqlite one, and an input for an unknown service are refused", () => {
        expect(planStack(withDb(), sel({databases: {db: {kind: "sqlite", path: "/lab/a.db"}}})).skipped).toContainEqual({key: "db:db", reason: "db_input_invalid"});
        const inv = withDb();
        inv.services[1].database_hint = {engine: "sqlite", basis: "mount"};
        expect(planStack(inv, sel({databases: {db: DUMP}})).skipped).toContainEqual({key: "db:db", reason: "db_input_invalid"});
        expect(planStack(withDb(), sel({databases: {ghost: DUMP}})).skipped).toContainEqual({key: "db:ghost", reason: "db_input_invalid"});
    });
    it("DB host rules: unique alias required, loopback/unspecified refused, required fields enforced per engine", () => {
        for (const h of ["demo-db", "db.internal", "10.0.0.7"]) expect(isAcceptableDbHost(h), h).toBe(true);
        for (const h of ["localhost", "127.0.0.1", "0.0.0.0", "::1", "", "a b", "db;rm", "-x", "x.localhost", "169.254.169.254"]) expect(isAcceptableDbHost(h), h).toBe(false);
        for (const bad of [{...DUMP, host: "localhost"}, {...DUMP, username: undefined}, {...DUMP, database: undefined}, {...DUMP, port: undefined}]) {
            expect(planStack(withDb(), selRaw({databases: {db: bad as never}})).skipped).toContainEqual({key: "db:db", reason: "db_input_invalid"});
        }
    });
});

describe("W10 plan: exclusions (D18) and manual sources (D19)", () => {
    it("an exclude hint is a default; explicit include wins; explicit exclude wins over defaults", () => {
        const inv = w10Inventory();
        inv.services[0].backup_hints = {exclude: true};
        const dflt = planStack(inv, sel());
        expect(dflt.sources.map((s) => s.role)).toEqual(["compose"]);
        expect(dflt.skipped.map((s) => s.reason)).toEqual(["excluded_hint", "excluded_hint"]);
        const forced = planStack(inv, sel({includeKeys: ["volume:app_data", `mount:${M2}`]}));
        expect(forced.sources.map((s) => s.role).sort()).toEqual(["bind", "compose", "volume"]);
        const out = planStack(w10Inventory(), sel({excludeKeys: ["volume:app_data"]}));
        expect(out.skipped).toContainEqual({key: "volume:app_data", reason: "excluded_selection"});
    });
    it("stop hints are carried as data and never reach a source config", () => {
        const p = planStack(w10Inventory(), sel({stop: ["web", "web"]}));
        expect(p.stop).toEqual(["web"]);
        expect(JSON.stringify(p.sources)).not.toContain("container");
    });
    it("a manual source needs a configured root, a safe path inside it, and existing keys; it covers them as manual_files", () => {
        const inv = w10Inventory({stack: {...w10Inventory().stack, compose_read: "none"}});
        const m = {path: "/srv/extra", covers: ["env:undetermined"]};
        expect(planStack(inv, sel({manual: [m]}), []).skipped).toContainEqual({key: "manual:/srv/extra", reason: "manual_invalid"});
        expect(planStack(inv, sel({manual: [{...m, path: "/opt/x"}]}), ["/srv"]).skipped).toContainEqual({key: "manual:/opt/x", reason: "manual_invalid"});
        expect(planStack(inv, sel({manual: [{...m, covers: ["volume:ghost"]}]}), ["/srv"]).skipped).toContainEqual({key: "manual:/srv/extra", reason: "manual_key_unknown"});
        const ok = planStack(inv, sel({manual: [m]}), ["/srv"]);
        const s = ok.sources.find((x) => x.origin === "manual");
        expect(s).toMatchObject({resourceKey: "manual:/srv/extra", role: "bind", dbms: "files", config: {path: "/srv/extra"}, coverage: "manual_files"});
        expect(ok.coverage["env:undetermined"]).toBe("manual_files");
        for (const bad of ["/etc/x", "/var/run/docker.sock", "/", "/srv/../etc"]) {
            expect(planStack(inv, selRaw({manual: [{path: bad, covers: ["env:undetermined"]}]}), ["/"]).sources.some((x) => x.origin === "manual"), bad).toBe(false);
        }
    });
    it("env:undetermined is never covered automatically (compose not read ⇒ only a manual source resolves it)", () => {
        const inv = w10Inventory({stack: {...w10Inventory().stack, compose_read: "none"}});
        expect(planStack(inv, sel()).coverage["env:undetermined"]).toBeUndefined();
    });
    it("no working dir → no compose source and an explicit skip", () => {
        const inv = w10Inventory({stack: {...w10Inventory().stack, working_dir_hint: undefined}});
        const p = planStack(inv, sel());
        expect(p.skipped).toContainEqual({key: "dir:?", reason: "compose_location_unknown"});
        expect(p.sources.some((s) => s.role === "compose")).toBe(false);
    });
});

describe("W10 plan ↔ W09 validator contract", () => {
    const probes = (keys: string[]): Record<string, ProbeResult> => Object.fromEntries(keys.map((k) => [k, "readable" as const]));
    it("a full plan of a clean stack, with every member probed readable, is COMPLETE", () => {
        const inv = w10Inventory();
        const p = planStack(inv, sel());
        const ctx: CompletenessContext = {coverage: p.coverage, probes: probes(Object.keys(p.coverage)), acceptedExclusions: [], allowedRoots: []};
        const r = validateCompleteness(inv, ctx);
        expect(r.blockers.map((b) => b.key)).toEqual([]);
        expect(r.complete).toBe(true);
    });
    it("the same plan WITHOUT probes is not complete (covered host paths stay unknown until a probe says readable)", () => {
        const inv = w10Inventory();
        const r = validateCompleteness(inv, {coverage: planStack(inv, sel()).coverage, probes: {}, acceptedExclusions: [], allowedRoots: []});
        expect(r.complete).toBe(false);
        expect(r.items.filter((i) => i.status === "unknown").length).toBeGreaterThan(0);
    });
    it("plan with a dumped DB: the DB is captured via engine dump (no file-copy-only)", () => {
        const inv = withDb();
        const p = planStack(inv, sel({databases: {db: DUMP}}));
        const r = validateCompleteness(inv, {coverage: p.coverage, probes: probes(Object.keys(p.coverage)), acceptedExclusions: [], allowedRoots: []});
        expect(r.fileCopyOnlyDatabases).toEqual([]);
        expect(r.items.find((i) => i.key === "db:db")).toMatchObject({status: "captured", consistency: "engine_dump"});
        expect(r.items.find((i) => i.key === "volume:app_pgdata")?.status).toBe("captured");
        expect(r.complete).toBe(true);
    });
});
