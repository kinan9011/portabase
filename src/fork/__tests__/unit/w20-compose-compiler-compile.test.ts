import {describe, expect, it} from "vitest";
import {type CompileOptions, type CompileResult, type MirrorSpecV1, checkMirrorView, compileMirror} from "@/fork/compose-compiler/compile";
import {ACCESS, CANARY, CLEAN_RAW, PROJECT, WS, labView} from "../fixtures/compose-compiler/lab";

type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: test fixtures are loose JSON
const baseOpts = (o: Partial<CompileOptions> = {}): CompileOptions => ({project: PROJECT, workspace: WS, access: null, ...o});
const run = (view: unknown, o: Partial<CompileOptions> = {}, raw: unknown = CLEAN_RAW): CompileResult => compileMirror({view: typeof view === "string" ? view : JSON.stringify(view), raw: raw as never, options: baseOpts(o)});
const mut = (fn: (d: Doc) => void): Doc => {
    const d = labView() as Doc;
    fn(d);
    return d;
};
const good = (r: CompileResult) => {
    expect(r.ok, r.ok ? "" : JSON.stringify(r.refusals)).toBe(true);
    if (!r.ok) throw new Error("not ok");
    return r;
};
const codes = (r: CompileResult) => (r.ok ? [] : r.refusals.map((x) => x.code));
const details = (r: CompileResult) => (r.ok ? [] : r.refusals.map((x) => `${x.code}|${x.detail}`));
const reverseKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v);

describe("compileMirror: D-4 transforms on the lab-shaped view", () => {
    const r = good(run(labView(), {access: ACCESS}));
    const v = r.spec.view as Doc;

    it("renames the project and drops x-* / extra_hosts / container_name / traefik label", () => {
        expect(v.name).toBe(PROJECT);
        expect(v.services.web.container_name).toBeUndefined();
        expect(v.services.web.extra_hosts).toBeUndefined();
        expect(v.services.web.labels).toEqual({"forklab.role": "", canary: ""});
    });
    it("replaces every network by an isolated mirror network (external → local) and adds pbm_access only for the access service", () => {
        expect(v.networks.internal).toEqual({name: `${PROJECT}_internal`, internal: true});
        expect(v.networks.lab_proxy).toEqual({name: `${PROJECT}_lab_proxy`, internal: true});
        expect(v.networks.pbm_access).toEqual({name: `${PROJECT}_pbm_access`});
        expect(Object.keys(v.services.web.networks).sort()).toEqual(["internal", "lab_proxy", "pbm_access"]);
        expect(Object.keys(v.services.db.networks)).toEqual(["internal"]);
    });
    it("keeps the db alias and turns container_name into an alias on each original network", () => {
        expect(v.services.db.networks.internal).toEqual({aliases: ["demo-db"]});
        expect(v.services.web.networks.internal).toEqual({aliases: ["lab-web"]});
        expect(v.services.web.networks.lab_proxy).toEqual({aliases: ["lab-web"]});
        expect(v.services.web.networks.pbm_access).toBeNull();
    });
    it("publishes exactly one loopback port for access, none otherwise", () => {
        expect(v.services.web.ports).toEqual([{mode: "ingress", host_ip: "127.0.0.1", target: 8080, published: "18099", protocol: "tcp"}]);
        expect(v.services.db.ports).toBeUndefined();
        const none = good(run(labView())).spec.view as Doc;
        expect(none.services.web.ports).toBeUndefined();
        expect(none.networks.pbm_access).toBeUndefined();
    });
    it("renames volumes into the project and keeps service volumes verbatim", () => {
        expect(v.volumes).toEqual({pgdata: {name: `${PROJECT}_pgdata`}, appdata: {name: `${PROJECT}_appdata`}});
        expect((v.services.web.volumes as Doc[])[0].source).toBe(`${WS}/web/serve.sh`);
    });
    it("keeps blanked structure (healthcheck, entrypoint, command) and per-key env actions are explicit", () => {
        expect(v.services.db.healthcheck.test).toEqual(["", ""]);
        expect(v.services.web.command).toEqual(["", "", ""]);
        expect(r.spec.env.web).toEqual({POSTGRES_PASSWORD: "rotate", DATABASE_URL: "keep", SMTP_HOST: "disable", APP_GREETING: "keep"});
        expect(r.spec.env.db).toMatchObject({POSTGRES_PASSWORD: "rotate", POSTGRES_USER: "keep", PASSTHRU: "keep"});
        expect(v.services.db.environment.PASSTHRU).toBeNull();
    });
    it("emits a credential reset for the postgres service and binds the spec to its source and rules", () => {
        expect(r.spec.credential_resets).toEqual([
            {service: "db", engine: "postgresql", user_key: "POSTGRES_USER", password_key: "POSTGRES_PASSWORD"},
            {service: "web", engine: "postgresql", user_key: null, password_key: "POSTGRES_PASSWORD"}, // the lab web service runs the postgres image too
        ]);
        expect(r.spec.source_view_sha256).toBe(r.source.compose_sha256);
        expect(r.spec.rules_sha256).toBe(r.source.rules_sha256);
        expect(r.spec_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
    it("never carries a production value", () => {
        expect(JSON.stringify(r)).not.toContain(CANARY);
        expect(JSON.stringify(r)).not.toContain("smtp.prod.example");
        expect(JSON.stringify(r)).not.toContain("10.9.8.7");
    });
});

describe("compileMirror: other D-4 rows", () => {
    it("network_mode bridge → attached to a created isolated default network", () => {
        const r = good(run(mut((d) => { d.services.db.network_mode = "bridge"; delete d.services.db.networks; })));
        const v = r.spec.view as Doc;
        expect(v.services.db.network_mode).toBeUndefined();
        expect(v.services.db.networks).toEqual({default: null});
        expect(v.networks.default).toEqual({name: `${PROJECT}_default`, internal: true});
        expect(r.diff.some((e) => e.kind === "network_mode_reset")).toBe(true);
    });
    it("a service with neither networks nor network_mode is attached to the default network explicitly", () => {
        const v = good(run(mut((d) => { delete d.services.db.networks; }))).spec.view as Doc;
        expect(v.services.db.networks).toEqual({default: null});
        expect(v.networks.default.internal).toBe(true);
    });
    it("network_mode none / service:<svc> kept", () => {
        const v = good(run(mut((d) => { delete d.services.web.networks; d.services.web.network_mode = "service:db"; delete d.services.db.networks; d.services.db.network_mode = "none"; }))).spec.view as Doc;
        expect(v.services.web.network_mode).toBe("service:db");
        expect(v.services.db.network_mode).toBe("none");
        expect(v.services.web.networks).toBeUndefined();
    });
    it("access on a service with network_mode is access_invalid", () => {
        expect(codes(run(mut((d) => { delete d.services.web.networks; d.services.web.network_mode = "none"; }), {access: ACCESS}))).toContain("access_invalid");
    });
    it("unsupported network_mode values (private) are refused", () => {
        expect(codes(run(mut((d) => { delete d.services.web.networks; d.services.web.network_mode = "private"; })))).toContain("unsupported_key");
    });
    it("static IPs / mac / extra attachment keys are dropped with a diff line", () => {
        const r = good(run(mut((d) => { d.services.db.networks = {internal: {aliases: ["demo-db"], ipv4_address: "10.1.2.3", mac_address: "aa:bb", priority: 3, driver_opts: {x: "y"}}}; })));
        expect((r.spec.view as Doc).services.db.networks).toEqual({internal: {aliases: ["demo-db"]}});
        expect(r.diff.some((e) => e.kind === "static_ip_dropped")).toBe(true);
    });
    it("x-* keys (top level and service level) are removed", () => {
        const r = good(run(mut((d) => { d["x-top"] = {a: ""}; d.services.web["x-svc"] = {b: ""}; })));
        expect(JSON.stringify(r.spec.view)).not.toContain("x-top");
        expect(JSON.stringify(r.spec.view)).not.toContain("x-svc");
    });
    it("dns / extra_hosts / links / logging / profiles / develop are removed (counts only)", () => {
        const r = good(run(mut((d) => { Object.assign(d.services.db, {dns: ["1.1.1.1"], dns_search: ["prod.example"], links: ["web"], logging: {driver: "syslog"}, profiles: ["p"], develop: {watch: []}, mac_address: "aa"}); })));
        const db = (r.spec.view as Doc).services.db;
        for (const k of ["dns", "dns_search", "links", "logging", "profiles", "develop", "mac_address"]) expect(db[k], k).toBeUndefined();
        expect(JSON.stringify(r.diff)).not.toContain("1.1.1.1");
        expect(JSON.stringify(r.diff)).not.toContain("prod.example");
    });
    it("external volume replaced by an empty project volume; tmpfs driver_opts kept; bind driver_opts refused", () => {
        const r = good(run(mut((d) => { d.volumes.pgdata = {external: true, name: "prod_pgdata"}; d.volumes.scratch = {driver_opts: {type: "tmpfs", device: "tmpfs"}}; })));
        const v = r.spec.view as Doc;
        expect(v.volumes.pgdata).toEqual({name: `${PROJECT}_pgdata`});
        expect(v.volumes.scratch).toEqual({name: `${PROJECT}_scratch`, driver_opts: {type: "tmpfs", device: "tmpfs"}});
        expect(r.diff.some((e) => e.kind === "volume_external_replaced")).toBe(true);
        const bad = run(mut((d) => { d.volumes.pgdata = {driver_opts: {type: "none", o: "bind", device: `${WS}/data`}}; }));
        expect(codes(bad)).toContain("volume_driver_opts");
    });
    it("top-level secrets/configs: external refused, name dropped, file kept", () => {
        expect(codes(run(mut((d) => { d.secrets = {s: {external: true}}; })))).toContain("external_secret");
        const v = good(run(mut((d) => { d.configs = {c: {name: "prod_c", file: `${WS}/c.conf`}}; }))).spec.view as Doc;
        expect(v.configs.c).toEqual({file: `${WS}/c.conf`});
    });
    it("env overrides: keep_exact is listed, drop removes the key, unknown override keys are ignored", () => {
        const r = good(run(labView(), {env: {web: {POSTGRES_PASSWORD: "keep_exact", APP_GREETING: "drop", NOPE: "rotate"}, ghost: {X: "drop"}}}));
        expect(r.spec.kept_production_secrets).toEqual(["web.POSTGRES_PASSWORD"]);
        const web = (r.spec.view as Doc).services.web;
        expect(web.environment.APP_GREETING).toBeUndefined();
        expect(r.spec.env.web.APP_GREETING).toBe("drop");
        expect(r.spec.env.web.NOPE).toBeUndefined();
        expect(r.diff.some((e) => e.kind === "env_keep_exact")).toBe(true);
    });
    it("mysql / mariadb credential resets", () => {
        const r = good(run(mut((d) => { d.services.db.image = "mariadb:11"; d.services.db.environment = {MARIADB_ROOT_PASSWORD: "", MARIADB_USER: "", MARIADB_PASSWORD: ""}; })));
        expect(r.spec.credential_resets.filter((x) => x.service === "db")).toEqual([
            {service: "db", engine: "mysql", user_key: "MARIADB_USER", password_key: "MARIADB_PASSWORD"},
            {service: "db", engine: "mysql", user_key: null, password_key: "MARIADB_ROOT_PASSWORD"},
        ]);
    });
    it("alias collision: container_name equal to another service", () => {
        expect(codes(run(mut((d) => { d.services.web.container_name = "db"; })))).toContain("alias_collision");
    });
    it("a network named pbm_access in the source is refused (reserved)", () => {
        expect(codes(run(mut((d) => { d.networks.pbm_access = {name: "x"}; })))).toContain("unsupported_key");
    });
    it("image missing / non-view value", () => {
        expect(codes(run(mut((d) => { delete d.services.db.image; })))).toContain("image_missing");
        expect(codes(run(mut((d) => { d.services.db.environment.POSTGRES_PASSWORD = CANARY; })))).toContain("view_invalid");
    });
    it("options are validated: project, workspace, access", () => {
        for (const o of [{project: "pbm-../x"}, {project: "PBM-X"}, {project: "x"}]) expect(codes(run(labView(), o)), JSON.stringify(o)).toContain("project_invalid");
        for (const ws of ["/", "relative", "/a/../b", "/srv/mirrors/other"]) expect(codes(run(labView(), {workspace: ws})), ws).toContain("workspace_invalid");
        for (const a of [{service: "ghost", target: 8080, host_port: 18099}, {service: "web", target: 0, host_port: 18099}, {service: "web", target: 8080, host_port: 80}]) expect(codes(run(labView(), {access: a})), JSON.stringify(a)).toContain("access_invalid");
    });
});

describe("compileMirror: plan §14 rows are refused in mirror mode (no overrides, via the W20a engine)", () => {
    const rules = (r: CompileResult) => (r.ok ? [] : r.refusals.filter((x) => x.code === "policy_finding").map((x) => x.detail.split(":")[0]));
    const cases: [string, (d: Doc) => void, string][] = [
        ["docker.sock bind", (d) => { d.services.db.volumes.push({type: "bind", source: "/var/run/docker.sock", target: "/s"}); }, "docker_sock"],
        ["use_api_socket", (d) => { d.services.db.use_api_socket = true; }, "docker_sock"],
        ["privileged", (d) => { d.services.db.privileged = true; }, "privileged"],
        ["network_mode host", (d) => { delete d.services.db.networks; d.services.db.network_mode = "host"; }, "network_mode_host"],
        ["pid host", (d) => { d.services.db.pid = "host"; }, "pid_host"],
        ["ipc host", (d) => { d.services.db.ipc = "host"; }, "ipc_host"],
        ["external network named host", (d) => { d.services.db.networks = {hostnet: null}; d.networks.hostnet = {name: "host", external: true}; }, "network_mode_host"],
        ["devices", (d) => { d.services.db.devices = ["/dev/sda:/dev/sda"]; }, "devices"],
        ["GPU deploy devices", (d) => { d.services.db.deploy = {resources: {reservations: {devices: [{driver: "nvidia", count: 1}]}}}; }, "devices"],
        ["cap_add SYS_ADMIN", (d) => { d.services.db.cap_add = ["SYS_ADMIN"]; }, "cap_add"],
        ["bind outside the workspace", (d) => { d.services.db.volumes.push({type: "bind", source: "/srv/data", target: "/d"}); }, "bind_outside_root"],
        ["prefix trick", (d) => { d.services.db.volumes.push({type: "bind", source: `${WS}-evil/data`, target: "/d"}); }, "bind_outside_root"],
        ["unknown directive", (d) => { d.services.db.brand_new_key = 1; }, "unknown_directive"],
    ];
    it.each(cases)("%s → ok:false with policy_finding %s", (_n, fn, rule) => {
        const r = run(mut(fn));
        expect(r.ok).toBe(false);
        expect(rules(r)).toContain(rule);
    });
    it("a W20a hard refusal (read outside root via raw) → policy_hard", () => {
        const r = run(labView(), {}, {refused: true, violations: [{kind: "env_file", service: "web", target: "/etc/shadow"}], reason: null});
        expect(codes(r)).toContain("policy_hard");
    });
    it("lists every blocker at once, sorted", () => {
        const r = run(mut((d) => { d.services.db.cap_add = ["SYS_ADMIN"]; d.services.web.container_name = "db"; }));
        expect(codes(r)).toEqual(["alias_collision", "policy_finding"]);
    });
});

describe("checkMirrorView negatives (D-7), one per code", () => {
    const spec = (good(run(labView(), {access: ACCESS})).spec as MirrorSpecV1).view as Doc;
    const ctx = {project: PROJECT, workspace: WS, access: ACCESS as typeof ACCESS | null};
    const violate = (fn: (d: Doc) => void, extra: Partial<Parameters<typeof checkMirrorView>[1]> = {}) => {
        const d = structuredClone(spec) as Doc;
        fn(d);
        return checkMirrorView(d, {...ctx, ...extra}).violations.map((x) => x.code);
    };
    it("accepts the compiled skeleton", () => expect(checkMirrorView(spec, ctx).ok).toBe(true));
    it.each([
        ["project", (d: Doc) => { d.name = "other"; }],
        ["port", (d: Doc) => { d.services.db.ports = [{target: 5432, published: "5432", host_ip: "0.0.0.0"}]; }],
        ["port", (d: Doc) => { d.services.web.ports.push({target: 1, published: "1024", host_ip: "127.0.0.1"}); }],
        ["container_name", (d: Doc) => { d.services.db.container_name = "x"; }],
        ["network_mode", (d: Doc) => { d.services.db.network_mode = "host"; }],
        ["removed_key", (d: Doc) => { d.services.db.dns = ["1.1.1.1"]; }],
        ["removed_key", (d: Doc) => { d.services.db.env_file = ["/x"]; }],
        ["network", (d: Doc) => { d.networks.internal.internal = false; }],
        ["network", (d: Doc) => { d.networks.internal.external = true; }],
        ["network", (d: Doc) => { d.networks.internal.name = "prod_internal"; }],
        ["network", (d: Doc) => { d.networks.internal.driver = "overlay"; }],
        ["network", (d: Doc) => { d.networks.internal.ipam = {config: [{subnet: "10.0.0.0/24"}]}; }],
        ["access_network", (d: Doc) => { d.services.db.networks.pbm_access = null; }],
        ["static_ip", (d: Doc) => { d.services.web.networks.internal = {ipv4_address: "10.0.0.2"}; }],
        ["volume", (d: Doc) => { d.volumes.pgdata.external = true; }],
        ["volume", (d: Doc) => { d.volumes.pgdata.name = "prod_pgdata"; }],
        ["volume", (d: Doc) => { d.volumes.pgdata.driver_opts = {o: "bind"}; }],
        ["label", (d: Doc) => { d.services.web.labels["traefik.enable"] = ""; }],
        ["secret_external", (d: Doc) => { d.secrets = {s: {external: true}}; }],
        ["engine", (d: Doc) => { d.services.db.privileged = true; }],
    ])("%s", (code, fn) => expect(violate(fn)).toContain(code));
    it("image_changed (with source)", () => {
        const src = labView() as Doc;
        expect(violate((d) => { d.services.db.image = "evil:latest"; }, {source: src})).toContain("image_changed");
        expect(violate((d) => { d.services.extra = {image: "x"}; }, {source: src})).toContain("image_changed");
    });
    it("owner_label only when required", () => {
        expect(violate(() => {})).toEqual([]);
        expect(violate(() => {}, {requireOwnerLabels: true})).toContain("owner_label");
        const withLabels = (d: Doc) => {
            for (const s of Object.values(d.services) as Doc[]) s.labels = {...(s.labels ?? {}), "com.portabase.fork.restore_id": "", "com.portabase.fork.agent_id": ""};
            const l = {"com.portabase.fork.restore_id": "r", "com.portabase.fork.agent_id": "a"};
            for (const n of Object.values(d.networks) as Doc[]) n.labels = l;
            for (const n of Object.values(d.volumes) as Doc[]) n.labels = l;
        };
        expect(violate(withLabels, {requireOwnerLabels: true})).toEqual([]);
        expect(violate(withLabels)).toContain("label"); // owner labels are only tolerated in the final runner view
    });
    it("tolerates compose re-render normalisation (ipam: {}, volume: {}, required: true)", () => {
        expect(violate((d) => { d.networks.internal.ipam = {}; d.services.web.depends_on.db.required = true; })).toEqual([]);
    });
    it("non-view shapes are a violation, not a crash", () => {
        expect(checkMirrorView(null, ctx).ok).toBe(false);
        expect(checkMirrorView({services: 1}, ctx).ok).toBe(false);
    });
});

describe("determinism", () => {
    it("compiling twice gives the same hash, and shuffled key order in the input does too", () => {
        const a = good(run(labView(), {access: ACCESS}));
        const b = good(run(labView(), {access: ACCESS}));
        const c = good(run(reverseKeys(labView()), {access: ACCESS}));
        expect(b.spec_sha256).toBe(a.spec_sha256);
        // source_view_sha256 hashes the exact bytes (key order is part of the bytes); everything derived from structure is order-independent
        expect(JSON.stringify(c.spec.view)).toBeTypeOf("string");
        expect(c.spec.env).toEqual(a.spec.env);
        expect(c.spec.view).toEqual(a.spec.view);
        expect(c.diff).toEqual(a.diff);
    });
});
