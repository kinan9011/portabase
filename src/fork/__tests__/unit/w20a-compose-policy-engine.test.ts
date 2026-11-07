import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {RENDERED_LIMITS, type PolicyVerdictV1, evaluateRenderedCompose} from "@/fork/policy/engine";
import {type RawResult, checkRawCompose} from "@/fork/policy/raw";
import {RULES, RULES_SHA256, RULE_IDS, type RuleId} from "@/fork/policy/rules";

const CLEAN: RawResult = {refused: false, violations: [], reason: null};
const ROOTS = ["/restore"];
type Doc = Record<string, unknown>;
const svc = (extra: Doc = {}): Doc => ({image: "nginx:1", networks: {default: null}, ...extra});
const doc = (services: Record<string, unknown>, top: Doc = {}): Doc => ({name: "r", services, networks: {default: {name: "r_default"}}, ...top});
const ev = (d: unknown, over: Partial<Parameters<typeof evaluateRenderedCompose>[0]> = {}) => evaluateRenderedCompose({rendered: typeof d === "string" || d instanceof Uint8Array ? d : JSON.stringify(d), roots: ROOTS, raw: CLEAN, drift: null, ...over});
const pairs = (v: PolicyVerdictV1) => v.findings.map((f) => `${f.service}|${f.rule}`);
const hardIds = (v: PolicyVerdictV1) => v.hard.map((h) => h.code);

afterEach(() => vi.restoreAllMocks());

describe("D-2 rows (one assertion group per row)", () => {
    it("H1 shape: not an object / services missing / service not object / bad volumes, networks, cap_add ⇒ deny shape_invalid", () => {
        for (const bad of ["[]", "null", "42", '"x"', "{}", '{"services":[]}', '{"services":{"a":5}}']) expect(hardIds(ev(bad)), bad).toContain("shape_invalid");
        expect(hardIds(ev(doc({a: svc({volumes: ["x"]})})))).toEqual(["shape_invalid"]);
        expect(hardIds(ev(doc({a: svc({volumes: {a: 1}})})))).toEqual(["shape_invalid"]);
        expect(hardIds(ev(doc({a: svc({networks: {ghost: null}})})))).toEqual(["shape_invalid"]);
        expect(hardIds(ev(doc({a: svc({networks: "default"})})))).toEqual(["shape_invalid"]);
        expect(hardIds(ev(doc({a: svc({volumes: [{type: "volume", source: "ghost", target: "/x"}]})})))).toEqual(["shape_invalid"]);
        expect(hardIds(ev(doc({a: svc({cap_add: "ALL"})})))).toEqual(["shape_invalid"]);
        expect(hardIds(ev(doc({a: svc({cap_add: [1]})})))).toEqual(["shape_invalid"]);
        expect(hardIds(ev(doc({a: svc({deploy: "x"})})))).toEqual(["shape_invalid"]);
        expect(hardIds(ev(doc({a: svc({deploy: {resources: {reservations: "x"}}})})))).toEqual(["shape_invalid"]);
        expect(ev("[]").verdict).toBe("deny");
    });
    it("H2 top-level unknown keys are hard, x-* are inert", () => {
        expect(hardIds(ev(doc({}, {models: {}})))).toEqual(["top_level_unknown"]);
        expect(ev(doc({}, {"x-anything": {a: 1}})).verdict).toBe("allow");
    });
    it("H3 service names: grammar, __proto__, empty, too long", () => {
        for (const n of ["bad name", "-lead", "", "a".repeat(129), "a/b", "__proto__"]) {
            const v = ev(`{"name":"r","services":{${JSON.stringify(n)}:{"image":"x"}},"networks":{"default":{"name":"d"}}}`);
            expect(hardIds(v), n).toEqual(["service_name"]);
        }
        expect(ev(doc({[`a${"b".repeat(127)}`]: svc()})).verdict).toBe("allow");
    });
    it("H4 paths: .., ., $, relative, //, trailing slash, control chars ⇒ hard path_ambiguous (never an override)", () => {
        for (const p of ["/restore/../etc", "/restore/./a", "/restore/$X", "data", "/restore//a", "/restore/a/", "/restore/a\nb", "/restore/a\u0000b", ""]) {
            const v = ev(doc({a: svc({volumes: [{type: "bind", source: p, target: "/x"}]})}));
            expect(hardIds(v), JSON.stringify(p)).toEqual(["path_ambiguous"]);
            expect(v.verdict).toBe("deny");
        }
    });
    it("H5 read scope of rendered secrets/configs/env_file", () => {
        expect(hardIds(ev(doc({}, {secrets: {s: {file: "/etc/shadow"}}})))).toEqual(["read_outside_root"]);
        expect(hardIds(ev(doc({}, {configs: {c: {file: "/etc/x"}}})))).toEqual(["read_outside_root"]);
        expect(hardIds(ev(doc({a: svc({env_file: [{path: "/etc/x"}]})})))).toEqual(["read_outside_root"]);
        expect(hardIds(ev(doc({a: svc({env_file: "../x"})})))).toEqual(["path_ambiguous"]);
        expect(ev(doc({a: svc({env_file: ["/restore/a.env", {path: "/restore/b.env"}]})}), {}).verdict).toBe("allow");
    });
    const flagged = (extra: Doc, top: Doc = {}) => pairs(ev(doc({a: svc(extra)}, top)));
    it("R1 privileged: true, 'true', 1 are flagged; false/null/absent are not", () => {
        for (const p of [true, "true", 1, "yes"]) expect(flagged({privileged: p})).toEqual(["a|privileged"]);
        for (const p of [false, null]) expect(flagged({privileged: p})).toEqual([]);
    });
    it("R2/R3 namespaces: host, container:, missing service, unknown value; service:<existing>, none, bridge ok", () => {
        expect(flagged({network_mode: "host"})).toEqual(["a|network_mode_host"]);
        expect(flagged({pid: "host"})).toEqual(["a|pid_host"]);
        expect(flagged({ipc: "host"})).toEqual(["a|ipc_host"]);
        for (const k of ["network_mode", "pid", "ipc"]) {
            expect(flagged({[k]: "container:x"}), k).toEqual(["a|shared_namespace"]);
            expect(flagged({[k]: "service:ghost"}), k).toEqual(["a|shared_namespace"]);
            expect(flagged({[k]: "weird"}), k).toEqual(["a|shared_namespace"]);
            expect(flagged({[k]: 5}), k).toEqual(["a|shared_namespace"]);
        }
        expect(pairs(ev(doc({a: svc(), b: {image: "x", network_mode: "service:a", pid: "service:a"}})))).toEqual([]);
        for (const ok of ["none", "bridge", "default", "private", "shareable"]) expect(flagged({ipc: ok}), ok).toEqual([]);
        expect(pairs(ev(doc({__proto__x: svc(), b: {image: "x", pid: "service:toString"}})))).toEqual(["b|shared_namespace"]); // inherited property names are not services
    });
    it("R4/R5 attached networks: host by name or driver, unknown drivers; bridge/overlay ok", () => {
        const net = (def: Doc) => doc({a: svc({networks: {n: null}})}, {networks: {default: {name: "d"}, n: def}});
        expect(pairs(ev(net({name: "host", external: true})))).toEqual(["a|network_mode_host"]);
        expect(pairs(ev(net({name: "x", driver: "host"})))).toEqual(["a|network_mode_host"]);
        expect(pairs(ev(net({name: "x", driver: "macvlan"})))).toEqual(["a|unknown_directive"]);
        expect(pairs(ev(net({name: "x", driver: 5})))).toEqual(["a|unknown_directive"]);
        for (const d of ["bridge", "overlay"]) expect(pairs(ev(net({name: "x", driver: d})))).toEqual([]);
        expect(pairs(ev(net({name: "x"})))).toEqual([]);
        expect(pairs(ev(doc({a: svc({networks: ["n"]})}, {networks: {n: {name: "host"}}})))).toEqual(["a|network_mode_host"]);
    });
    it("R6 devices: list, deploy reservations, odd types; null/[]/absent are not", () => {
        expect(flagged({devices: [{source: "/dev/fuse", target: "/dev/fuse"}]})).toEqual(["a|devices"]);
        expect(flagged({devices: "/dev/fuse"})).toEqual(["a|devices"]);
        expect(flagged({deploy: {resources: {reservations: {devices: [{driver: "nvidia"}]}}}})).toEqual(["a|devices"]);
        for (const d of [[], null]) expect(flagged({devices: d, deploy: {resources: {reservations: {devices: d}}}})).toEqual([]);
        expect(flagged({deploy: {replicas: 2, resources: {limits: {cpus: "1"}}}})).toEqual([]);
    });
    it("R7 cap_add: case/prefix normalised, allow-list honoured", () => {
        for (const c of ["SYS_ADMIN", "cap_sys_admin", "ALL", "net_admin", "CAP_CAP_NET_ADMIN", "sys_admin "]) expect(flagged({cap_add: [c]}), c).toEqual(["a|cap_add"]);
        expect(flagged({cap_add: ["NET_BIND_SERVICE", "chown", "CAP_KILL"]})).toEqual([]);
        expect(flagged({cap_add: ["kıll"]})).toEqual(["a|cap_add"]); // dotless i must not upper-case into an allowed name
    });
    it("R8 use_api_socket", () => {
        expect(flagged({use_api_socket: true})).toEqual(["a|docker_sock"]);
        expect(flagged({use_api_socket: false})).toEqual([]);
    });
    it("R9 bind mounts: socket, socket parents, outside root, root prefix trick; inside is fine; both rules can fire", () => {
        const b = (source: string) => flagged({volumes: [{type: "bind", source, target: "/x"}]}).sort();
        expect(b("/var/run/docker.sock")).toEqual(["a|bind_outside_root", "a|docker_sock"]);
        expect(b("/run/docker.sock")).toEqual(["a|bind_outside_root", "a|docker_sock"]);
        expect(b("/var/run")).toEqual(["a|bind_outside_root", "a|docker_sock"]);
        expect(b("/")).toEqual(["a|bind_outside_root", "a|docker_sock"]);
        expect(b("/etc")).toEqual(["a|bind_outside_root"]);
        expect(b("/restore-evil")).toEqual(["a|bind_outside_root"]);
        expect(b("/restore/data/docker.sock")).toEqual(["a|docker_sock"]);
        expect(b("/restore")).toEqual([]);
        expect(b("/restore/a/b")).toEqual([]);
    });
    it("R10 named volumes: bind-through-driver_opts is treated like a bind; tmpfs, plain local and external are fine", () => {
        const v = (def: Doc) => pairs(ev(doc({a: svc({volumes: [{type: "volume", source: "d", target: "/x"}]})}, {volumes: {d: def}}))).sort();
        expect(v({driver: "local", driver_opts: {type: "none", o: "bind", device: "/etc"}})).toEqual(["a|bind_outside_root"]);
        expect(v({driver_opts: {type: "none", o: "bind", device: "/var/run"}})).toEqual(["a|bind_outside_root", "a|docker_sock"]);
        expect(v({driver_opts: {type: "none", o: "bind", device: "/restore/x"}})).toEqual([]);
        expect(v({driver_opts: {type: "nfs", device: ":/x"}})).toEqual(["a|unknown_directive"]);
        expect(v({driver_opts: {device: "relative"}})).toEqual(["a|unknown_directive"]);
        expect(v({driver: "rexray"})).toEqual(["a|unknown_directive"]);
        expect(v({driver_opts: {type: "tmpfs", device: "tmpfs"}})).toEqual([]);
        expect(v({name: "shared", external: true})).toEqual([]);
        expect(v({})).toEqual([]);
        expect(hardIds(ev(doc({a: svc({volumes: [{type: "volume", source: "d", target: "/x"}]})}, {volumes: {d: {driver_opts: "x"}}})))).toEqual(["shape_invalid"]);
        expect(pairs(ev(doc({a: svc({volumes: [{type: "volume", target: "/anon"}]})})))).toEqual([]);
    });
    it("R11 mount types: tmpfs ok, anything else unknown", () => {
        for (const t of ["npipe", "cluster", "image", "bogus"]) expect(flagged({volumes: [{type: t, target: "/x", source: "s"}]}), t).toEqual(["a|unknown_directive"]);
        expect(flagged({volumes: [{type: "tmpfs", target: "/tmp"}]})).toEqual([]);
        expect(flagged({volumes: [{target: "/x"}]})).toEqual(["a|unknown_directive"]);
    });
    it("R12 security_opt: only no-new-privileges spellings", () => {
        expect(flagged({security_opt: ["no-new-privileges:true"]})).toEqual([]);
        expect(flagged({security_opt: ["no-new-privileges=true", "no-new-privileges"]})).toEqual([]);
        for (const o of [["seccomp=unconfined"], ["apparmor=unconfined"], ["label=disable"], [5], "no-new-privileges"]) expect(flagged({security_opt: o}), JSON.stringify(o)).toEqual(["a|unknown_directive"]);
    });
    it("R13 service keys: unknown ⇒ unknown_directive per key, x-* ignored, every known key accepted", () => {
        for (const k of ["build", "volumes_from", "userns_mode", "cgroup_parent", "gpus", "runtime", "uts", "extends", "label_file", "provider", "models", "storage_opt"]) expect(flagged({[k]: "x"}), k).toEqual(["a|unknown_directive"]);
        expect(flagged({"x-foo": 1, "x-bar": {a: 1}})).toEqual([]);
        const all = Object.fromEntries(RULES.service_keys_known.filter((k) => !["privileged", "use_api_socket", "network_mode", "pid", "ipc", "devices", "cap_add", "security_opt", "env_file", "networks", "volumes", "deploy"].includes(k)).map((k) => [k, "x"]));
        expect(flagged(all)).toEqual([]);
    });
});

describe("verdict shape, determinism, mutation", () => {
    it("verdict classes: hard ⇒ deny (and still lists findings), findings ⇒ needs-explicit-override, none ⇒ allow", () => {
        const v = ev(doc({a: svc({privileged: true, volumes: [{type: "bind", source: "/restore/../x", target: "/x"}]})}));
        expect(v.verdict).toBe("deny");
        expect(v.findings.map((f) => f.rule)).toEqual(["privileged"]);
        expect(v.services_needing_override).toEqual(["a"]);
        expect(ev(doc({a: svc({privileged: true})})).verdict).toBe("needs-explicit-override");
        expect(ev(doc({a: svc()})).verdict).toBe("allow");
    });
    it("plain-language text uses the rule file's words and names the service; details are sanitised and bounded", () => {
        const v = ev(doc({web: svc({volumes: [{type: "bind", source: `/etc/${"a b".repeat(100)}`, target: "/x"}]})}));
        const f = v.findings.find((x) => x.rule === "bind_outside_root");
        expect(f?.plain.startsWith(`service "web" ${RULES.rules.find((r) => r.id === "bind_outside_root")?.plain} (`)).toBe(true);
        expect(f?.detail.length).toBeLessThanOrEqual(128);
        expect(f?.detail).not.toMatch(/[^A-Za-z0-9_./:=?-]/);
    });
    it("compose hash is SHA-256 of the exact bytes (string and Uint8Array agree, one byte changes it); rules hash is the file hash", () => {
        const text = JSON.stringify(doc({a: svc()}));
        const v = ev(text);
        expect(v.compose_sha256).toBe(createHash("sha256").update(text).digest("hex"));
        expect(ev(new TextEncoder().encode(text)).compose_sha256).toBe(v.compose_sha256);
        expect(ev(`${text} `).compose_sha256).not.toBe(v.compose_sha256);
        expect(v.rules_sha256).toBe(RULES_SHA256);
    });
    it("determinism: shuffling service and key order never changes findings or hard refusals", () => {
        const base = doc({a: svc({privileged: true, cap_add: ["SYS_ADMIN"], volumes: [{type: "bind", source: "/etc", target: "/x"}]}), b: svc({network_mode: "host"}), c: svc({userns_mode: "host"})});
        const shuffle = (o: unknown, seed: number): unknown => {
            if (Array.isArray(o)) return o.map((x) => shuffle(x, seed + 1));
            if (typeof o !== "object" || o === null) return o;
            const e = Object.entries(o).map(([k, x]) => [k, shuffle(x, seed + 1)] as const);
            return Object.fromEntries(e.sort((p, q) => ((p[0].charCodeAt(0) * seed) % 7) - ((q[0].charCodeAt(0) * seed) % 7)));
        };
        const want = ev(base);
        for (const seed of [3, 5, 11, 13]) {
            const got = ev(shuffle(base, seed));
            expect({findings: got.findings, hard: got.hard}).toEqual({findings: want.findings, hard: want.hard});
        }
    });
    it("mutation: removing the offending key makes exactly that finding disappear (every rule)", () => {
        const KEYS: Record<RuleId, string[]> = {
            privileged: ["privileged"], network_mode_host: ["network_mode", "networks"], pid_host: ["pid"], ipc_host: ["ipc"], devices: ["devices", "deploy"], cap_add: ["cap_add"],
            docker_sock: ["volumes", "use_api_socket"], bind_outside_root: ["volumes"], shared_namespace: ["network_mode", "pid", "ipc"], unknown_directive: ["build", "volumes_from", "userns_mode", "security_opt", "networks", "volumes"],
        };
        const corpus = JSON.parse(readFileSync(path.join(process.cwd(), "src/fork/policy/compose-policy-vectors.json"), "utf8")) as {rendered: {name: string; compose: Doc; roots: string[]; expect: {verdict: string; findings: [string, RuleId][]}}[]};
        let mutated = 0;
        for (const vec of corpus.rendered.filter((x) => x.expect.verdict === "needs-explicit-override")) {
            for (const [service, rule] of vec.expect.findings) {
                const m = JSON.parse(JSON.stringify(vec.compose)) as {services: Record<string, Doc>};
                for (const k of KEYS[rule]) delete m.services[service]?.[k];
                const after = evaluateRenderedCompose({rendered: JSON.stringify(m), roots: vec.roots, raw: CLEAN, drift: null});
                expect(pairs(after), `${vec.name}: ${service}|${rule}`).not.toContain(`${service}|${rule}`);
                mutated++;
            }
        }
        expect(mutated).toBeGreaterThanOrEqual(35);
        expect(new Set(corpus.rendered.flatMap((x) => x.expect.findings.map((f) => f[1])))).toEqual(new Set(RULE_IDS));
    });
});

describe("limits, roots and the raw result (D-10, D-3)", () => {
    it("rendered JSON limits: > 2 MiB, depth > 32, > 500 services, not JSON ⇒ deny", () => {
        const big = JSON.stringify(doc({a: svc({"x-pad": "x".repeat(RENDERED_LIMITS.maxBytes)})}));
        expect(hardIds(ev(big))).toEqual(["limits"]);
        const deep = (d: number) => `{"services":{},"x-deep":${"[".repeat(d)}${"]".repeat(d)}}`;
        expect(hardIds(ev(deep(40)))).toEqual(["limits"]);
        expect(ev(deep(20)).verdict).toBe("allow");
        expect(ev(`{"services":{},"x-s":"${"[".repeat(500)}"}`).verdict).toBe("allow"); // brackets inside strings do not count
        expect(hardIds(ev(doc(Object.fromEntries(Array.from({length: 501}, (_, i) => [`s${i}`, svc()])))))).toEqual(["limits"]);
        expect(ev(doc(Object.fromEntries(Array.from({length: 500}, (_, i) => [`s${i}`, svc()])))).verdict).toBe("allow");
        for (const junk of ["", "not json", "{", '{"services":{}} trailing']) expect(hardIds(ev(junk)), junk).toEqual(["shape_invalid"]);
        expect(hardIds(ev(new Uint8Array([0xff, 0xfe, 0x00])))).toEqual(["shape_invalid"]);
    });
    it("roots must be canonical, not '/', not a docker-socket path; none at all is refused; two roots work", () => {
        for (const roots of [[], ["/"], ["relative"], ["/restore/../x"], ["/var/run"], ["/run"], ["/restore", "/"]]) expect(hardIds(ev(doc({a: svc()}), {roots})), JSON.stringify(roots)).toContain("path_ambiguous");
        const two = doc({a: svc({volumes: [{type: "bind", source: "/srv/data/x", target: "/x"}]})});
        expect(ev(two, {roots: ["/restore", "/srv/data"]}).verdict).toBe("allow");
        expect(ev(two, {roots: ["/restore"]}).verdict).toBe("needs-explicit-override");
    });
    it("the raw result is merged: outside targets ⇒ read_outside_root, missing ⇒ raw_incomplete, reason ⇒ yaml_invalid/limits; clean raw changes nothing", () => {
        const d = doc({a: svc()});
        expect(hardIds(ev(d, {raw: {refused: true, violations: [{kind: "env_file", service: "a", target: "/etc/x"}], reason: null}}))).toEqual(["read_outside_root"]);
        expect(hardIds(ev(d, {raw: {refused: true, violations: [{kind: "missing", service: null, target: "/restore/x.yml"}], reason: null}}))).toEqual(["raw_incomplete"]);
        expect(hardIds(ev(d, {raw: {refused: true, violations: [], reason: "yaml_invalid"}}))).toEqual(["yaml_invalid"]);
        expect(hardIds(ev(d, {raw: {refused: true, violations: [], reason: "limits"}}))).toEqual(["limits"]);
        expect(hardIds(ev(d, {raw: {refused: true, violations: [], reason: null}}))).toEqual(["yaml_invalid"]); // an inconsistent refusal still refuses
        expect(ev(d).verdict).toBe("allow");
    });
    it("notes: compose_changed_since_rp / compose_change_unknown / none (inventory hashes, never change the verdict)", () => {
        const d = doc({a: svc()});
        const h1 = "a".repeat(64);
        const h2 = "b".repeat(64);
        expect(ev(d, {drift: {rp_sequence: 7, rp_inventory_hash: h1, current_inventory_hash: h2}}).notes).toEqual([{code: "compose_changed_since_rp", rp_sequence: 7, plain: "Stack configuration (as discovered) changed since recovery point #7."}]);
        expect(ev(d, {drift: {rp_sequence: 7, rp_inventory_hash: null, current_inventory_hash: h2}}).notes.map((n) => n.code)).toEqual(["compose_change_unknown"]);
        expect(ev(d, {drift: {rp_sequence: 7, rp_inventory_hash: h1, current_inventory_hash: null}}).notes.map((n) => n.code)).toEqual(["compose_change_unknown"]);
        expect(ev(d, {drift: {rp_sequence: 7, rp_inventory_hash: h1, current_inventory_hash: h1}}).notes).toEqual([]);
        expect(ev(d).notes).toEqual([]);
        expect(ev(d, {drift: {rp_sequence: 7, rp_inventory_hash: h1, current_inventory_hash: h2}}).verdict).toBe("allow");
    });
});

describe("secrets never leave the engine (canary)", () => {
    it("a planted canary in 8 rendered locations (+ a raw-yaml value) appears nowhere in the verdict", () => {
        const CAN = `CANARY-w20a-${Math.random().toString(36).slice(2)}`;
        const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
        const d = doc({a: svc({privileged: true, environment: {PASSWORD: CAN}, labels: {k: CAN}, command: ["sh", "-c", CAN], entrypoint: [CAN], healthcheck: {test: ["CMD", CAN]}, "x-secret": CAN, env_file: "/etc/shadow"})},
            {secrets: {s: {environment: CAN, file: "/etc/shadow"}}, configs: {c: {content: CAN}}, "x-top": CAN});
        const v = ev(d, {raw: {refused: true, violations: [{kind: "env_file", service: "a", target: "/etc/shadow"}], reason: null}});
        expect(v.verdict).toBe("deny");
        expect(v.findings.length + v.hard.length).toBeGreaterThan(2);
        expect(JSON.stringify(v)).not.toContain(CAN);
        for (const s of spies) expect(s).not.toHaveBeenCalled();
    });
});

/** Env-gated lab check (FORK_LAB_COMPOSE=1): renders the synthetic lab demo stack LOCALLY (reads files, starts nothing, no network) and runs the real bytes through TS and the CLI jq. */
describe.skipIf(!process.env.FORK_LAB_COMPOSE)("lab demo stack, really rendered (W20a §5.4)", () => {
    const CLI = path.join(process.cwd(), "scripts/fork/recover/portabase-recover");
    const RULES_PATH = path.join(process.cwd(), "src/fork/policy/compose-deny.json");
    const cliPairs = (bytes: string, root: string) => {
        const r = spawnSync("bash", ["-c", 'source "$1"; DENY="$2"; RESTORE_ROOT="$3"; evaluate_deny', "_", CLI, RULES_PATH, root], {input: bytes, encoding: "utf8"});
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as {service: string; rule: string}).map((x) => `${x.service}|${x.rule}`).sort();
    };
    it("allow for the clean stack; exactly the four §2.3 findings once the poison override is added; TS and CLI agree", () => {
        const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "w20a-lab-")));
        try {
            const dir = path.join(tmp, "demo-stack");
            cpSync(path.join(process.cwd(), "dev/fork-lab/demo-stack"), dir, {recursive: true});
            const render = (files: string[]) => {
                const r = spawnSync("docker", ["compose", ...files.flatMap((f) => ["-f", f]), "config", "--format", "json"], {cwd: dir, encoding: "utf8"});
                expect(r.status, r.stderr).toBe(0);
                return r.stdout;
            };
            const raw = (files: string[]) => checkRawCompose({root: tmp, entry: files.map((f) => path.join(dir, f)), files: files.map((f) => ({path: path.join(dir, f), text: readFileSync(path.join(dir, f), "utf8")}))});
            const base = ["compose.yml", "compose.override.yml"];
            const clean = render(base);
            const v1 = evaluateRenderedCompose({rendered: clean, roots: [tmp], raw: raw(base), drift: null});
            expect(v1.hard).toEqual([]);
            expect(pairs(v1)).toEqual([]);
            expect(v1.verdict).toBe("allow");
            expect(cliPairs(clean, tmp)).toEqual([]);

            writeFileSync(path.join(dir, "poison.yml"), "services:\n  web:\n    use_api_socket: true\n    security_opt: [seccomp=unconfined]\n    networks: [hostnet]\n    volumes:\n      - type: volume\n        source: evil\n        target: /evil\nnetworks:\n  hostnet:\n    external: true\n    name: host\nvolumes:\n  evil:\n    driver: local\n    driver_opts: {type: none, o: bind, device: /etc}\n");
            const all = [...base, "poison.yml"];
            const poisoned = render(all);
            const v2 = evaluateRenderedCompose({rendered: poisoned, roots: [tmp], raw: raw(all), drift: null});
            const want = ["web|bind_outside_root", "web|docker_sock", "web|network_mode_host", "web|unknown_directive"];
            expect(v2.hard).toEqual([]);
            expect(pairs(v2).sort()).toEqual(want);
            expect(v2.verdict).toBe("needs-explicit-override");
            expect(cliPairs(poisoned, tmp)).toEqual(want);
            const out = process.env.LAB_EVIDENCE_DIR;
            if (out) writeFileSync(path.join(out, "lab-compose-verdicts.json"), `${JSON.stringify({clean: {...v1, roots: ["<tmp-copy>"]}, poisoned: {...v2, roots: ["<tmp-copy>"]}}, null, 1)}\n`);
        } finally {
            rmSync(tmp, {recursive: true, force: true});
        }
    });
});
