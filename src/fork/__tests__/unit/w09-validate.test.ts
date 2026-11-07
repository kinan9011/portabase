import {describe, expect, it} from "vitest";
import {cleanInventory, FULL_COVERAGE, richInventory} from "@/fork/__tests__/w09-fixtures";
import {EMPTY_CONTEXT, GAP_STATUSES, ITEM_STATUSES, validateCompleteness, type CompletenessContext} from "@/fork/completeness";

const ctx = (over: Partial<CompletenessContext> = {}): CompletenessContext => ({...EMPTY_CONTEXT, ...over});
const full = (over: Partial<CompletenessContext> = {}) => ctx({...FULL_COVERAGE, ...over});
const find = (r: ReturnType<typeof validateCompleteness>, key: string) => r.items.find((i) => i.key === key)!;

describe("plan §14 matrix (first 7 rows) as fixtures", () => {
    it("1. compose + override + env file, all covered and probed: every original captured, complete", () => {
        const r = validateCompleteness(cleanInventory(), full());
        expect(["file:/srv/app/compose.yml", "file:/srv/app/compose.override.yml", "env:/srv/app/stack.env"].map((k) => find(r, k).status)).toEqual(["captured", "captured", "captured"]);
        expect(r.complete).toBe(true);
        expect(r.blockers).toEqual([]);
    });

    it("1b. the same stack before any source exists: every file is missing and the stack is NOT complete", () => {
        const r = validateCompleteness(cleanInventory());
        expect(find(r, "file:/srv/app/compose.yml").status).toBe("missing");
        expect(find(r, "file:/srv/app/compose.override.yml").status).toBe("missing");
        expect(r.complete).toBe(false);
        expect(r.blockers.length).toBeGreaterThanOrEqual(3);
    });

    it("2. named volume + bind mount: both are required and both must be covered", () => {
        const r = validateCompleteness(cleanInventory(), full());
        expect(find(r, "volume:app_data").status).toBe("captured");
        expect(find(r, "mount:m:0000000000000002").status).toBe("captured");
        const half = validateCompleteness(cleanInventory(), full({coverage: {...FULL_COVERAGE.coverage, "volume:app_data": undefined as never}}));
        expect(find(half, "volume:app_data").status).toBe("missing");
        expect(half.complete).toBe(false);
    });

    it("3. shared external network: ownership detected, informational, never a gap", () => {
        const inv = cleanInventory({networks: [{name: "app_default", driver: "bridge", internal: false, external: false, members: ["web"], classification: "stack_owned"}, {name: "proxy", driver: "bridge", internal: false, external: true, members: ["web"], classification: "shared_external"}]});
        const r = validateCompleteness(inv, full());
        const n = find(r, "network:proxy");
        expect(n).toMatchObject({status: "external", reason: "external_network", severity: "info", gap: false});
        expect(r.complete).toBe(true);
        expect(find(r, "network:app_default")).toBeUndefined(); // recreated from compose, not a resource of its own
    });

    it("4. custom IPAM / static subnets: network metadata is retained in the report and flags nothing", () => {
        const inv = cleanInventory({networks: [{name: "app_default", driver: "bridge", internal: true, external: false, subnets: ["172.30.0.0/24"], members: ["web"], classification: "stack_owned"}]});
        const r = validateCompleteness(inv, full());
        expect(r.networks).toEqual([{name: "app_default", ownership: "stack_owned", subnets: ["172.30.0.0/24"]}]);
        expect(r.complete).toBe(true);
    });

    it("5. missing .env / referenced config file: a blocker, never complete (probe says absent)", () => {
        const r = validateCompleteness(cleanInventory(), full({probes: {...FULL_COVERAGE.probes, "env:/srv/app/stack.env": "absent"}}));
        expect(find(r, "env:/srv/app/stack.env")).toMatchObject({status: "missing", reason: "file_absent", severity: "blocker", gap: true, resolvable: true});
        expect(r.complete).toBe(false);
        const cfg = validateCompleteness(cleanInventory(), full({probes: {...FULL_COVERAGE.probes, "file:/srv/app/compose.override.yml": "absent"}}));
        expect(find(cfg, "file:/srv/app/compose.override.yml").status).toBe("missing");
        expect(cfg.complete).toBe(false);
    });

    it("6. unreadable bind mount: inaccessible and blocking, not silently ignored", () => {
        const r = validateCompleteness(cleanInventory(), full({probes: {...FULL_COVERAGE.probes, "mount:m:0000000000000002": "unreadable"}}));
        expect(find(r, "mount:m:0000000000000002")).toMatchObject({status: "inaccessible", reason: "unreadable", severity: "blocker", gap: true, resolvable: true});
        expect(r.complete).toBe(false);
    });

    it("6b. until the agent probe exists a covered bind is `unknown`, not captured", () => {
        const r = validateCompleteness(cleanInventory(), full({probes: {}}));
        expect(find(r, "mount:m:0000000000000002").status).toBe("unknown");
        expect(r.complete).toBe(false);
    });

    it("7. unpublished local image: flagged (restore preflight needs an archived image), a gap, resolvable by nothing in R1", () => {
        const inv = cleanInventory();
        inv.services[0]!.image = {ref: "demo/web:1.0", pinned: false, built_locally: true};
        const r = validateCompleteness(inv, full());
        expect(find(r, "image:web")).toMatchObject({status: "unsupported", reason: "image_local", severity: "warn", gap: true, resolvable: false});
        expect(r.complete).toBe(false);
    });
});

describe("never complete while anything is unknown", () => {
    it("compose not read ⇒ env files cannot be known ⇒ unknown ⇒ not complete, even with everything else covered", () => {
        const inv = cleanInventory({env_files: []});
        inv.stack.compose_read = "none";
        const r = validateCompleteness(inv, full());
        expect(find(r, "env:undetermined")).toMatchObject({status: "unknown", reason: "env_files_undetermined", gap: true});
        expect(r.complete).toBe(false);
    });
    it("an implicit .env nobody probed is unknown; probed absent removes it", () => {
        const noProbe = validateCompleteness(cleanInventory(), full({probes: {...FULL_COVERAGE.probes, "env:implicit": undefined as never}, coverage: {...FULL_COVERAGE.coverage, "env:implicit": undefined as never}}));
        expect(find(noProbe, "env:implicit")).toMatchObject({status: "unknown", reason: "env_implicit_unknown"});
        const absent = validateCompleteness(cleanInventory(), full({probes: {...FULL_COVERAGE.probes, "env:implicit": "absent"}}));
        expect(absent.items.find((i) => i.key === "env:implicit")).toBeUndefined();
        expect(absent.complete).toBe(true);
    });
    it("no compose location label ⇒ compose_location_unknown (missing, resolvable by a manual source)", () => {
        const inv = cleanInventory();
        inv.stack.config_files_hint = [];
        const r = validateCompleteness(inv, full());
        expect(find(r, "file:?")).toMatchObject({status: "missing", reason: "compose_location_unknown", resolvable: true});
        expect(r.complete).toBe(false);
    });
    it("invariant over many contexts: complete ⇒ no item has a gap status", () => {
        const invs = [cleanInventory(), richInventory()];
        for (const inv of invs) for (const c of [EMPTY_CONTEXT, full(), full({probes: {}}), full({acceptedExclusions: ["file:?"]})]) {
            const r = validateCompleteness(inv, c);
            if (r.complete) expect(r.items.every((i) => !GAP_STATUSES.includes(i.status))).toBe(true);
            expect(r.items.every((i) => ITEM_STATUSES.includes(i.status))).toBe(true);
        }
    });
});

describe("databases (D29)", () => {
    const dbInv = () => cleanInventory({services: [{name: "db", state: "running", image: {ref: "postgres:17", pinned: false, built_locally: false}, ports: [], networks: [], mounts: ["m:0000000000000001"], env_keys: [], database_hint: {engine: "postgresql", basis: "image"}}], mounts: [{id: "m:0000000000000001", kind: "named_volume", volume_name: "app_data", destination: "/var/lib/postgresql/data", rw: true, consumers: ["db"], ownership: "stack_owned"}], env_files: []});
    const fc = (over: Partial<CompletenessContext> = {}) => ctx({coverage: {...FULL_COVERAGE.coverage, ...(over.coverage ?? {})}, probes: FULL_COVERAGE.probes});

    it("engine dump source ⇒ captured, saved safely", () => {
        const r = validateCompleteness(dbInv(), fc({coverage: {"db:db": "engine_dump"}}));
        expect(find(r, "db:db")).toMatchObject({status: "captured", reason: "captured", consistency: "engine_dump", gap: false});
        expect(r.complete).toBe(true);
    });
    it("only its data volume copied as files ⇒ a gap (Partial material), listed, never complete", () => {
        const r = validateCompleteness(dbInv(), fc());
        expect(find(r, "db:db")).toMatchObject({status: "captured", reason: "db_file_copy_only", consistency: "files_only", gap: true, severity: "warn"});
        expect(r.fileCopyOnlyDatabases).toEqual(["db"]);
        expect(r.complete).toBe(false);
    });
    it("nothing covers it ⇒ missing blocker", () => {
        const r = validateCompleteness(dbInv(), ctx());
        expect(find(r, "db:db")).toMatchObject({status: "missing", severity: "blocker"});
    });
    it("a data volume of an EXCLUDED service does not make the database look file-copied", () => {
        const inv = dbInv();
        inv.services[0]!.backup_hints = {exclude: true};
        const r = validateCompleteness(inv, fc());
        expect(find(r, "db:db").status).toBe("excluded");
    });
});

describe("exclusions, external, accepted (D18, UX-20, SEC-22)", () => {
    it("exclude label ⇒ `excluded` (by label), not missing; labels are defaults only", () => {
        const inv = cleanInventory();
        inv.volumes[0]!.backup_hints = {exclude: true};
        const r = validateCompleteness(inv, ctx());
        expect(find(r, "volume:app_data")).toMatchObject({status: "excluded", reason: "excluded_by_label", gap: false});
    });
    it("accepted exclusion ⇒ own state, not a gap, not counted as a warning; the accepted key wins over everything", () => {
        const inv = cleanInventory();
        inv.services[0]!.image = {ref: "demo/web:1.0", pinned: false, built_locally: true};
        const r = validateCompleteness(inv, full({acceptedExclusions: ["image:web"]}));
        expect(find(r, "image:web")).toMatchObject({status: "accepted_exclusion", reason: "accepted", gap: false, severity: "info"});
        expect(r.counts.accepted).toBe(1);
        expect(r.counts.warnings).toBe(0);
        expect(r.complete).toBe(true);
    });
    it("external shared volume ⇒ external (warn), not a gap; remote service dependency ⇒ external (info)", () => {
        const inv = cleanInventory();
        inv.volumes.push({name: "shared_media", driver: "local", in_use_by: ["web"], ownership: "external_shared"});
        inv.external_dependencies.push({kind: "remote_service", name: "smtp.example.test", note_key: "x"});
        const r = validateCompleteness(inv, full());
        expect(find(r, "volume:shared_media")).toMatchObject({status: "external", severity: "warn", gap: false});
        expect(find(r, "dep:remote_service:smtp.example.test")).toMatchObject({status: "external", severity: "info"});
        expect(r.complete).toBe(true);
    });
    it("anonymous volume ⇒ missing (warn); excluded when every consumer is excluded", () => {
        const r = validateCompleteness(richInventory(), ctx());
        expect(r.items.find((i) => i.kind === "anonymous_volume")).toMatchObject({status: "missing", reason: "anonymous_volume", severity: "warn"});
        const inv = richInventory();
        inv.services[1]!.backup_hints = {exclude: true};
        expect(validateCompleteness(inv, ctx()).items.find((i) => i.kind === "anonymous_volume")!.status).toBe("excluded");
    });
    it("non-`local` volume driver ⇒ unsupported blocker unless covered", () => {
        const inv = cleanInventory();
        inv.volumes[0] = {name: "app_data", driver: "nfs-plugin", in_use_by: ["web"], ownership: "stack_owned"};
        expect(find(validateCompleteness(inv, ctx()), "volume:app_data")).toMatchObject({status: "unsupported", reason: "volume_driver", severity: "blocker"});
        expect(find(validateCompleteness(inv, full()), "volume:app_data").status).toBe("captured");
    });
});

describe("paths (SEC-15 / SEC-22 / SEC-24)", () => {
    const withBind = (host: string | undefined, roots: string[] = []) => {
        const inv = cleanInventory();
        inv.mounts[1] = {id: "m:0000000000000002", kind: "bind", destination: "/up", ...(host !== undefined ? {host_path_hint: host} : {}), rw: true, consumers: ["web"], ownership: "unknown"};
        return validateCompleteness(inv, full({allowedRoots: roots}));
    };
    it("outside configured roots ⇒ unsupported even though a source claims to cover it", () => {
        const r = withBind("/srv/other/data", ["/srv/app"]);
        expect(find(r, "mount:m:0000000000000002")).toMatchObject({status: "unsupported", reason: "outside_allowed_roots", severity: "blocker"});
    });
    it("inside a root ⇒ fine; no roots configured ⇒ only the hard deny list applies", () => {
        expect(find(withBind("/srv/app/uploads", ["/srv/app"]), "mount:m:0000000000000002").status).toBe("captured");
        expect(find(withBind("/srv/app/uploads"), "mount:m:0000000000000002").status).toBe("captured");
    });
    it("root of the filesystem, traversal, relative and control-character paths ⇒ unsupported denied_path", () => {
        for (const p of ["/", "/srv/app/../../etc", "relative/path", "/srv/app/\u0000x", "/srv/" + "a".repeat(1100)]) {
            expect(find(withBind(p), "mount:m:0000000000000002")).toMatchObject({status: "unsupported", reason: "denied_path"});
        }
        expect(find(withBind(undefined), "mount:m:0000000000000002")).toMatchObject({status: "unsupported", reason: "denied_path"});
    });
    it("a root-prefix lookalike is not inside the root", () => {
        expect(find(withBind("/srv/application/x", ["/srv/app"]), "mount:m:0000000000000002").status).toBe("unsupported");
    });
    it("docker socket and system paths are directives (restore refuses without override), not data and not gaps", () => {
        for (const [p, code] of [["/var/run/docker.sock", "docker_socket"], ["/run/docker.sock", "docker_socket"], ["/etc/localtime", "system_path"], ["/proc", "system_path"]] as const) {
            const r = withBind(p);
            expect(r.items.find((i) => i.key === "mount:m:0000000000000002")).toBeUndefined();
            expect(r.directives).toContainEqual({code, service: "web", detail: "/up"});
            expect(r.complete).toBe(true);
        }
    });
    it("hostile compose-file hints are refused, never echoed as trusted", () => {
        const inv = cleanInventory();
        inv.stack.config_files_hint = ["/srv/app/../../etc/shadow"];
        const r = validateCompleteness(inv, full());
        expect(find(r, "file:/srv/app/../../etc/shadow")).toMatchObject({status: "unsupported", reason: "denied_path", placement: null});
    });
    it("a compose/env file hint inside a system path or at the docker socket is refused (never a captured config file)", () => {
        const inv = cleanInventory();
        inv.stack.config_files_hint = ["/etc/passwd", "/var/run/docker.sock"];
        inv.env_files = [{path_hint: "/proc/self/environ", key_names: [], referenced_by: ["web"]}];
        const r = validateCompleteness(inv, full());
        for (const k of ["file:/etc/passwd", "file:/var/run/docker.sock", "env:/proc/self/environ"]) expect(find(r, k), k).toMatchObject({status: "unsupported", reason: "denied_path"});
        expect(r.complete).toBe(false);
    });
    it("placement: files under the working dir are managed here, others are referenced from outside", () => {
        const inv = cleanInventory();
        inv.stack.config_files_hint = ["/srv/app/compose.yml", "/opt/shared/base.yml"];
        const r = validateCompleteness(inv, full());
        expect(find(r, "file:/srv/app/compose.yml").placement).toBe("here");
        expect(find(r, "file:/opt/shared/base.yml").placement).toBe("outside");
    });
});

describe("directives (§4.4 informational)", () => {
    it("privileged, host network and shared network namespace are reported, never gaps", () => {
        const inv = cleanInventory();
        inv.services.push({name: "agent", state: "running", image: {ref: "x", pinned: true, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: [], privileged: true, network_mode: "host"});
        inv.services.push({name: "side", state: "running", image: {ref: "y", pinned: true, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: [], network_mode: "container:abc"});
        const r = validateCompleteness(inv, full());
        expect(r.directives).toEqual(expect.arrayContaining([{code: "privileged", service: "agent", detail: null}, {code: "host_network", service: "agent", detail: null}, {code: "shared_netns", service: "side", detail: null}]));
        expect(r.complete).toBe(true);
    });
});

describe("lab-shaped inventory (richInventory)", () => {
    it("discovery alone: not complete, blockers listed, nothing claims capture", () => {
        const r = validateCompleteness(richInventory(), ctx());
        expect(r.complete).toBe(false);
        expect(r.counts.captured).toBe(0);
        expect(r.blockers.length).toBeGreaterThan(0);
        expect(r.items.some((i) => i.kind === "image" && i.reason === "image_local")).toBe(true);
        expect(r.items.some((i) => i.kind === "network" && i.status === "external")).toBe(true);
    });
    it("is pure: the same input twice gives the same report and the input is not mutated", () => {
        const inv = richInventory();
        const before = JSON.stringify(inv);
        expect(validateCompleteness(inv, ctx())).toEqual(validateCompleteness(inv, ctx()));
        expect(JSON.stringify(inv)).toBe(before);
    });
});
