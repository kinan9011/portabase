import {describe, expect, it} from "vitest";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";
import {art, H, kumaInput, planInput, u} from "@/fork/__tests__/w16-fixtures";
import {contentHash} from "@/fork/inventory/schema";
import {planRestore, PlannerRefusal} from "@/fork/restore/plan";
import type {PlanInputV1} from "@/fork/restore/schema";

const run = (i: PlanInputV1) => planRestore(i).plan;
const act = (p: ReturnType<typeof run>, kind: string, key?: string) => p.actions.find((a) => a.kind === kind && (key === undefined || a.resource_key === key));
const refusal = (i: PlanInputV1) => { try { planRestore(i); return null; } catch (e) { if (e instanceof PlannerRefusal) return e.code; throw e; } };
const decision = (p: ReturnType<typeof run>, code: string) => p.decisions.filter((d) => d.code === code);

describe("matrix 1: baseline new_stack on a clean host", () => {
    it("clean host without an environment is production/default, needs the production approval and is ready", () => {
        const p = run(planInput((i) => { i.target.environments = []; }));
        expect(p.target).toMatchObject({host_role: "production", host_role_source: "default", project: "app", restore_root: "/srv/restore"});
        expect(p.approvals_required).toEqual([{kind: "production_target", capability: "restore.production.approve"}]);
        expect(p.blockers).toEqual([]);
        expect(p.outcome).toBe("ready");
        expect(p.actions.map((a) => a.kind)).toEqual(["restore_compose_dir", "restore_volume", "restore_db_dump", "compose_up"]);
        expect(p.actions.map((a) => a.order)).toEqual([1, 2, 3, 4]);
        expect(p.preconditions.find((x) => x.code === "target_facts_fresh")).toMatchObject({state: "deferred", reason: "no_target_inventory"});
        expect(p.preconditions.find((x) => x.code === "manifest_signature")).toMatchObject({state: "deferred", checked_by: "orchestrator"});
    });
    it("destinations are deterministic and under restore_root/<project>", () => {
        const p = run(planInput());
        expect(act(p, "restore_compose_dir")?.destination.path).toBe("/srv/restore/app/compose");
        expect(act(p, "restore_volume")?.destination).toMatchObject({kind: "volume", name: "app_data"});
        expect(act(p, "compose_up")?.destination).toMatchObject({kind: "project", name: "app"});
    });
});

describe("matrix 2: path escape", () => {
    const bindInput = (hint: string | undefined) => planInput((i) => {
        const inv = cleanInventory({mounts: [{id: "m:0000000000000009", kind: "bind", destination: "/up", host_path_hint: hint, rw: true, consumers: ["web"], ownership: "unknown"}]});
        i.inventory = inv; i.inventory_content_hash = contentHash(inv); i.rp.inventory_hash = contentHash(inv);
        i.artifacts = [art(31, "mount:m:0000000000000009", "bind", "files"), i.artifacts[0]];
    });
    it.each(["/srv/../etc/x", "/etc/passwd", "/var/run/docker.sock", "$HOME/x", "~/x", "/srv/a\u0001b", "data", "/srv/$X/y", "/srv/~u/y"])("hostile bind hint %j ⇒ blocked path_rejected", (hint) => {
        const p = run(bindInput(hint));
        const a = act(p, "restore_path");
        expect(a?.risk).toBe("blocked");
        expect(a?.reasons).toContain("path_rejected");
        expect(p.outcome).toBe("blocked");
        expect(p.blockers).toContain("path_rejected");
    });
    it("a missing mount hint is rejected, never guessed", () => {
        expect(act(run(bindInput(undefined)), "restore_path")?.reasons).toContain("path_rejected");
    });
    it("a safe bind is relocated under restore_root/<project>/binds", () => {
        const a = act(run(bindInput("/srv/app/uploads")), "restore_path");
        expect(a?.destination.path).toBe("/srv/restore/app/binds/srv/app/uploads");
        expect(a?.source.original_path).toBe("/srv/app/uploads");
        expect(a?.risk).toBe("safe");
    });
    it.each([["/", "restore_root_rejected"], ["/etc", "restore_root_rejected"], ["/srv/../etc", "restore_root_rejected"], ["relative", "restore_root_rejected"], ["/srv/$X", "restore_root_rejected"], ["/srv/~", "restore_root_rejected"], ["/var/run/docker.sock", "restore_root_rejected"], [null, "restore_root_required"], ["", "restore_root_required"]])("restore_root %j ⇒ %s", (root, code) => {
        const p = run(planInput((i) => { i.mappings.restore_root = root; }));
        expect(p.blockers).toContain(code);
        expect(p.target.restore_root).toBeNull();
        expect(p.actions.filter((a) => a.destination.path !== null && a.kind !== "restore_volume")).toEqual([]);
    });
    it("a root outside the declared allowed roots is refused; strictly-under is accepted; the root itself is not", () => {
        const env = (roots: string[]) => (i: PlanInputV1) => { i.target.environments[0].allowed_path_roots = roots; };
        expect(run(planInput((i) => { env(["/data"])(i); i.mappings.restore_root = "/srv/restore"; })).blockers).toContain("restore_root_outside_allowed_roots");
        expect(run(planInput((i) => { env(["/srv"])(i); i.mappings.restore_root = "/srv/restore"; })).blockers).toEqual([]);
        expect(run(planInput((i) => { env(["/srv"])(i); i.mappings.restore_root = "/srv"; })).blockers).toContain("restore_root_outside_allowed_roots");
    });
    it("PROPERTY: for 200 generated inputs every destination.path stays under restore_root (or a known root for existing_stack)", () => {
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
        const hints = ["/srv/app/uploads", "/srv/../etc", "/etc/x", "/var/run/docker.sock", "/data/a/b", "/", "rel", "/srv/$A", "/srv//app///x/", "/tmp/./y", "/srv/app/../../x", "/home/u/.ssh", "/app/data"];
        const roots = ["/srv/restore", "/mnt/r", "/srv", "/srv/restore/", "/", "/etc/r", "rel", "/srv/../x", "/data", "/srv/restore/deep/er"];
        for (let n = 0; n < 200; n++) {
            const mode = pick(["new_stack", "selective", "existing_stack"] as const);
            const known = rnd() < 0.5 ? pick([["/srv"], ["/data"], ["/srv/restore", "/mnt"], []]) : [];
            const mounts = [0, 1, 2].map((k) => ({id: `m:000000000000000${k}`, kind: "bind" as const, destination: "/d", host_path_hint: pick(hints), rw: true, consumers: ["web"], ownership: "unknown" as const}));
            const inv = cleanInventory({mounts});
            const p = run(planInput((i) => {
                i.mode = mode; i.mappings.restore_root = pick(roots); i.mappings.select = mode === "selective" ? mounts.map((m) => `mount:${m.id}`) : null;
                i.target.environments[0].allowed_path_roots = known;
                if (mode === "existing_stack") i.target.facts.projects = ["app"];
                i.inventory = inv; i.inventory_content_hash = contentHash(inv); i.rp.inventory_hash = contentHash(inv);
                i.artifacts = mounts.map((m, k) => art(40 + k, `mount:${m.id}`, "bind", "files")).concat([art(11, "dir:/srv/app", "compose", "files")]);
            }));
            const root = p.target.restore_root;
            for (const a of p.actions) {
                const dp = a.destination.path;
                if (dp === null) continue;
                if (a.risk === "blocked") throw new Error(`blocked action carries a path: ${dp}`);
                const ok = (mode === "existing_stack" && a.destination.kind === "path" && known.some((r) => dp === r || dp.startsWith(`${r.replace(/\/$/, "")}/`))) || (root !== null && (dp === root || dp.startsWith(`${root}/`)));
                expect(ok, `${mode} ${dp} root=${root} known=${known}`).toBe(true);
                expect(dp.split("/")).not.toContain("..");
            }
        }
    });
});

describe("matrix 3: shared network", () => {
    const withNet = (cls: "stack_owned" | "shared_external" | "manual", name: string, over: (i: PlanInputV1) => void = () => {}) => {
        const inv = cleanInventory({networks: [{name, driver: "bridge", internal: false, external: cls !== "stack_owned", members: ["web"], classification: cls}]});
        return planInput((i) => { i.inventory = inv; i.inventory_content_hash = contentHash(inv); i.rp.inventory_hash = contentHash(inv); over(i); }, inv);
    };
    it("a stack-owned network name that exists on the target is a plan blocker with a flagged decision", () => {
        const p = run(withNet("stack_owned", "app_default", (i) => { i.target.facts.networks = ["app_default"]; }));
        expect(p.blockers).toContain("network_name_conflict");
        expect(decision(p, "network_name_conflict")).toEqual([expect.objectContaining({flagged: true, subject: "app_default"})]);
    });
    it("the collision is checked against the RENAMED project network", () => {
        const p = run(withNet("stack_owned", "app_default", (i) => { i.mappings.target_project = "app2"; i.target.facts.networks = ["app_default"]; }));
        expect(p.blockers).not.toContain("network_name_conflict");
        const q = run(withNet("stack_owned", "app_default", (i) => { i.mappings.target_project = "app2"; i.target.facts.networks = ["app2_default"]; }));
        expect(q.blockers).toContain("network_name_conflict");
    });
    it("a shared_external network that already exists is reused: flagged decision, not blocking", () => {
        const p = run(withNet("shared_external", "proxy", (i) => { i.target.facts.networks = ["proxy"]; }));
        expect(decision(p, "shared_network_reused")).toEqual([expect.objectContaining({flagged: true})]);
        expect(p.blockers).toEqual([]);
        expect(act(p, "create_network")).toBeUndefined();
    });
    it("a missing shared network becomes a create_network action that needs approval, flagged", () => {
        const p = run(withNet("shared_external", "proxy"));
        const a = act(p, "create_network");
        expect(a).toMatchObject({op: "create", phase: "start", risk: "needs_approval", destination: {kind: "network", name: "proxy"}});
        expect(decision(p, "shared_network_missing")[0].flagged).toBe(true);
        expect(p.blockers).toEqual([]);
    });
    it("existing_stack never conflicts with its own networks", () => {
        const p = run(withNet("stack_owned", "app_default", (i) => { i.mode = "existing_stack"; i.target.facts.projects = ["app"]; i.target.facts.networks = ["app_default"]; i.target.environments[0].allowed_path_roots = ["/srv"]; }));
        expect(p.blockers).not.toContain("network_name_conflict");
    });
});

describe("matrix 4: unpublished / unpinned images", () => {
    const withImage = (img: Partial<NonNullable<PlanInputV1["inventory"]>["services"][number]["image"]>, over: (i: PlanInputV1) => void = () => {}) => {
        const base = cleanInventory();
        const inv = cleanInventory({services: [{...base.services[0], image: {...base.services[0].image, ...img}}]});
        return planInput((i) => { i.inventory = inv; i.inventory_content_hash = contentHash(inv); i.rp.inventory_hash = contentHash(inv); over(i); }, inv);
    };
    it("built locally and restored to another environment ⇒ blocker image_unpublished with a flagged decision", () => {
        const p = run(withImage({built_locally: true}));
        expect(p.blockers).toContain("image_unpublished");
        expect(decision(p, "image_unpublished")[0].flagged).toBe(true);
    });
    it("built locally, same environment ⇒ unflagged decision, no blocker", () => {
        const p = run(withImage({built_locally: true}, (i) => { i.target.same_environment = true; }));
        expect(p.blockers).not.toContain("image_unpublished");
        expect(decision(p, "image_unpublished")[0].flagged).toBe(false);
    });
    it("unpinned image ⇒ unflagged image_unpinned, not blocking", () => {
        const p = run(withImage({pinned: false, digest: undefined}));
        expect(decision(p, "image_unpinned")).toEqual([expect.objectContaining({flagged: false})]);
        expect(p.blockers).toEqual([]);
    });
});

describe("matrix 5: arch + disk", () => {
    it("known arch and incompatible image platforms ⇒ arch_mismatch", () => {
        const ref = cleanInventory().services[0].image.ref;
        const p = run(planInput((i) => { i.target.facts.arch = "arm64"; i.target.facts.image_platforms = {[ref]: ["amd64"]}; }));
        expect(p.blockers).toContain("arch_mismatch");
        expect(p.preconditions.find((x) => x.code === "arch_compat")).toMatchObject({state: "unmet", reason: "arch_mismatch"});
    });
    it("compatible ⇒ met; unknown ⇒ deferred to the agent (honest, never 'met')", () => {
        const ref = cleanInventory().services[0].image.ref;
        expect(run(planInput((i) => { i.target.facts.arch = "amd64"; i.target.facts.image_platforms = {[ref]: ["amd64", "arm64"]}; })).preconditions.find((x) => x.code === "arch_compat")?.state).toBe("met");
        expect(run(planInput()).preconditions.find((x) => x.code === "arch_compat")).toMatchObject({state: "deferred", checked_by: "agent"});
    });
    it("free disk known and below 110% of the plaintext total ⇒ insufficient_disk; enough ⇒ met; unknown ⇒ deferred", () => {
        const total = 3000; // 3 artifacts × 1000
        expect(run(planInput()).totals.plaintext_bytes).toBe(total);
        expect(run(planInput((i) => { i.target.facts.free_disk_bytes = 3299; })).blockers).toContain("insufficient_disk");
        expect(run(planInput((i) => { i.target.facts.free_disk_bytes = 3300; })).preconditions.find((x) => x.code === "free_disk")?.state).toBe("met");
        expect(run(planInput()).preconditions.find((x) => x.code === "free_disk")).toMatchObject({state: "deferred", checked_by: "agent"});
    });
    it("an unknown plaintext size makes the requirement unknown (never invented)", () => {
        const p = run(planInput((i) => { i.artifacts[1].plaintext_size = null; i.target.facts.free_disk_bytes = 1; }));
        expect(p.totals.plaintext_bytes).toBeNull();
        expect(p.blockers).not.toContain("insufficient_disk");
    });
});

describe("matrix 6: existing volume / existing target", () => {
    it("new_stack: destination volume exists ⇒ blocked volume_exists + flagged decision with a free suggestion", () => {
        const p = run(planInput((i) => { i.target.facts.volumes = ["app_data"]; }));
        expect(act(p, "restore_volume")).toMatchObject({risk: "blocked", reasons: ["volume_exists"]});
        expect(decision(p, "volume_exists")).toEqual([expect.objectContaining({flagged: true, suggestion: "app_data-restored"})]);
        expect(p.blockers).toContain("volume_exists");
    });
    it("a volume mapping removes the collision; a renamed project renames project-prefixed volumes", () => {
        expect(run(planInput((i) => { i.target.facts.volumes = ["app_data"]; i.mappings.volumes = {app_data: "app_data_new"}; })).outcome).toBe("ready");
        const p = run(planInput((i) => { i.mappings.target_project = "app2"; }));
        expect(act(p, "restore_volume")?.destination.name).toBe("app2_data");
    });
    it("a mapped volume name that is not adoptable ⇒ volume_name_rejected", () => {
        const p = run(planInput((i) => { i.mappings.volumes = {app_data: "/etc"}; }));
        expect(act(p, "restore_volume")).toMatchObject({risk: "blocked", reasons: ["volume_name_rejected"]});
    });
    it("existing_stack: replace + destructive + destructive_replace approval; needs known roots for paths", () => {
        const p = run(planInput((i) => { i.mode = "existing_stack"; i.target.facts.projects = ["app"]; i.target.facts.volumes = ["app_data"]; i.target.environments[0].allowed_path_roots = ["/srv"]; }));
        expect(act(p, "restore_volume")).toMatchObject({op: "replace", destructive: true, risk: "needs_approval", reasons: ["replaces_existing_data"]});
        expect(act(p, "restore_compose_dir")).toMatchObject({op: "replace", destructive: true, destination: {path: "/srv/app"}});
        expect(act(p, "compose_up")).toMatchObject({op: "replace", destructive: true});
        expect(p.approvals_required.map((a) => a.kind)).toEqual(["production_target", "destructive_replace"]);
        expect(p.preconditions.find((x) => x.code === "safety_snapshot")).toMatchObject({state: "deferred", checked_by: "orchestrator"});
        expect(p.outcome).toBe("ready");
    });
    it("existing_stack: absent volume ⇒ create (not destructive)", () => {
        const p = run(planInput((i) => { i.mode = "existing_stack"; i.target.facts.projects = ["app"]; i.target.environments[0].allowed_path_roots = ["/srv"]; }));
        expect(act(p, "restore_volume")).toMatchObject({op: "create", destructive: false});
    });
    it("existing_stack without known roots ⇒ allowed_roots_unknown; outside ⇒ path_outside_allowed_roots", () => {
        const base = (roots: string[]) => planInput((i) => { i.mode = "existing_stack"; i.target.facts.projects = ["app"]; i.target.environments[0].allowed_path_roots = roots; });
        expect(act(run(base([])), "restore_compose_dir")?.reasons).toContain("allowed_roots_unknown");
        expect(act(run(base(["/data"])), "restore_compose_dir")?.reasons).toContain("path_outside_allowed_roots");
    });
});

describe("matrix 7-10: ports, project conflicts, existing target", () => {
    it("published port in use ⇒ flagged decision, compose_up needs approval, still not blocked", () => {
        const inv = cleanInventory({services: [{...cleanInventory().services[0], ports: [{target: 80, published: 8080, protocol: "tcp"}]}]});
        const p = run(planInput((i) => { i.target.facts.published_ports = [{port: 8080, protocol: "tcp"}]; }, inv));
        expect(decision(p, "port_in_use")).toEqual([expect.objectContaining({flagged: true, subject: "8080/tcp"})]);
        expect(act(p, "compose_up")).toMatchObject({risk: "needs_approval", reasons: ["port_in_use"]});
        expect(p.outcome).toBe("ready");
        // different protocol does not collide
        expect(decision(run(planInput((i) => { i.target.facts.published_ports = [{port: 8080, protocol: "udp"}]; }, inv)), "port_in_use")).toEqual([]);
    });
    it("same project name on the target ⇒ blocker + flagged decision with a suggestion; renaming resolves it", () => {
        const p = run(planInput((i) => { i.target.facts.projects = ["app"]; }));
        expect(p.blockers).toContain("project_name_conflict");
        expect(decision(p, "project_name_conflict")).toEqual([expect.objectContaining({flagged: true, suggestion: "app-restored"})]);
        expect(run(planInput((i) => { i.target.facts.projects = ["app"]; i.mappings.target_project = "app-restored"; })).blockers).toEqual([]);
    });
    it("existing_stack: project absent on the target ⇒ existing_stack_not_on_target; target_project differing from the source ⇒ conflict", () => {
        expect(run(planInput((i) => { i.mode = "existing_stack"; i.target.environments[0].allowed_path_roots = ["/srv"]; })).blockers).toContain("existing_stack_not_on_target");
        expect(run(planInput((i) => { i.mode = "existing_stack"; i.mappings.target_project = "other"; i.target.facts.projects = ["app", "other"]; i.target.environments[0].allowed_path_roots = ["/srv"]; })).blockers).toContain("project_name_conflict");
    });
});

describe("matrix 11: selective", () => {
    const sel = (select: string[] | null) => planInput((i) => { i.mode = "selective"; i.mappings.select = select; });
    it("restores only the selected keys, skips the rest as not_selected, never compose_up", () => {
        const p = run(sel(["volume:app_data"]));
        expect(act(p, "restore_volume")?.op).toBe("create");
        expect(p.actions.filter((a) => a.op === "skip").map((a) => [a.resource_key, a.reasons])).toEqual([["dir:/srv/app", ["not_selected"]], ["db:db", ["not_selected"]]]);
        expect(act(p, "compose_up")).toBeUndefined();
        expect(p.preconditions.find((x) => x.code === "target_capability_compose")).toBeUndefined();
        expect(p.outcome).toBe("ready");
        expect(p.totals.plaintext_bytes).toBe(1000);
    });
    it("unknown key ⇒ selection_unknown_key; empty/absent ⇒ nothing_selected", () => {
        expect(run(sel(["volume:nope"])).blockers).toContain("selection_unknown_key");
        expect(run(sel([])).blockers).toContain("nothing_selected");
        expect(run(sel(null)).blockers).toContain("nothing_selected");
    });
});

describe("matrix 12: test_restore (D44)", () => {
    const test = (mut?: (i: PlanInputV1) => void) => planInput((i) => {
        i.purpose = "test_restore"; i.target.environments = [{id: u(70), name: "scratch", host_role: "test", allowed_path_roots: [], facts_fresh: true}]; mut?.(i);
    });
    it("test environment ⇒ ok, data-only, no secrets, no approvals, everything under scratch with op create", () => {
        const p = run(test());
        expect(p.outcome).toBe("ready");
        expect(p.secrets).toEqual([]);
        expect(p.approvals_required).toEqual([]);
        expect(p.compose_findings).toEqual([]);
        expect(p.actions.map((a) => a.kind)).toEqual(["restore_compose_dir", "restore_volume", "restore_db_dump"]);
        for (const a of p.actions) { expect(a.op).toBe("create"); expect(a.destination.path).toMatch(/^\/srv\/restore\/app\/scratch\//); }
        expect(act(p, "restore_volume")?.destination.path).toBe("/srv/restore/app/scratch/volumes/app_data");
        expect(act(p, "restore_db_dump")?.destination.path).toBe("/srv/restore/app/scratch/db/db");
    });
    it("skips the volume-exists / project-conflict checks (nothing but a scratch directory is created)", () => {
        const p = run(test((i) => { i.target.facts.volumes = ["app_data"]; i.target.facts.projects = ["app"]; }));
        expect(p.blockers).toEqual([]);
    });
    it("production / no environment / mixed environments ⇒ refused test_restore_target_not_test", () => {
        expect(refusal(planInput((i) => { i.purpose = "test_restore"; }))).toBe("test_restore_target_not_test");
        expect(refusal(planInput((i) => { i.purpose = "test_restore"; i.target.environments = []; }))).toBe("test_restore_target_not_test");
        expect(refusal(test((i) => { i.target.environments.push({id: u(71), name: "prod", host_role: "production", allowed_path_roots: [], facts_fresh: true}); }))).toBe("test_restore_target_not_test");
    });
    it("personal data: NULL / true without opt-in ⇒ refused; false ⇒ ok; true + opt-in ⇒ ok", () => {
        expect(refusal(test((i) => { i.stack.contains_personal_data = null; }))).toBe("personal_data_no_opt_in");
        expect(refusal(test((i) => { i.stack.contains_personal_data = true; }))).toBe("personal_data_no_opt_in");
        expect(refusal(test((i) => { i.stack.contains_personal_data = false; }))).toBeNull();
        expect(refusal(test((i) => { i.stack.contains_personal_data = true; i.stack.test_restore_opt_in = true; }))).toBeNull();
        expect(refusal(test((i) => { i.stack.contains_personal_data = null; i.stack.test_restore_opt_in = true; }))).toBeNull();
    });
    it("mode other than new_stack ⇒ test_restore_mode_invalid (checked first)", () => {
        expect(refusal(test((i) => { i.mode = "existing_stack"; }))).toBe("test_restore_mode_invalid");
        expect(refusal(test((i) => { i.mode = "selective"; }))).toBe("test_restore_mode_invalid");
    });
});

describe("matrix 13: pilot shape (uptime-kuma: named volume + sqlite)", () => {
    it("without a sqlite mapping the file is staged only, needs approval, with a flagged decision", () => {
        const p = run(kumaInput());
        expect(p.actions.map((a) => [a.phase, a.kind, a.op])).toEqual([["stage", "restore_compose_dir", "create"], ["data", "restore_volume", "create"], ["db", "restore_sqlite_file", "stage_only"], ["start", "compose_up", "create"]]);
        const s = act(p, "restore_sqlite_file");
        expect(s).toMatchObject({risk: "needs_approval", destructive: false, reasons: ["sqlite_placement_unresolved"], destination: {kind: "stage"}});
        expect(s?.destination.path).toMatch(/^\/srv\/restore\/uptime-kuma\/stage\/[0-9a-f]{8}$/);
        expect(decision(p, "sqlite_placement_unresolved")).toEqual([expect.objectContaining({flagged: true})]);
        expect(p.outcome).toBe("ready");
    });
    it("with a valid mapping the sqlite file replaces the file inside the freshly restored volume, after the volume, safe", () => {
        const p = run(kumaInput((i) => { i.mappings.sqlite = {"uptime-kuma": {volume: "uptime-kuma_data", relative_path: "kuma.db"}}; }));
        const s = act(p, "restore_sqlite_file");
        expect(s).toMatchObject({op: "replace", risk: "safe", destructive: false, destination: {kind: "volume", name: "uptime-kuma_data", relative_path: "kuma.db"}});
        expect(s!.order).toBeGreaterThan(act(p, "restore_volume")!.order);
        expect(decision(p, "sqlite_placement_unresolved")).toEqual([]);
        expect(p.approvals_required.map((a) => a.kind)).toEqual(["production_target"]);
    });
    it.each([["../../etc/x", "uptime-kuma_data"], ["/abs/kuma.db", "uptime-kuma_data"], ["a/../b", "uptime-kuma_data"], ["$X/kuma.db", "uptime-kuma_data"], ["", "uptime-kuma_data"], ["kuma.db", "no_such_volume"]])("mapping %j in volume %j ⇒ sqlite_mapping_rejected", (relative_path, volume) => {
        const p = run(kumaInput((i) => { i.mappings.sqlite = {"uptime-kuma": {volume, relative_path}}; }));
        expect(act(p, "restore_sqlite_file")).toMatchObject({risk: "blocked", reasons: ["sqlite_mapping_rejected"]});
        expect(p.outcome).toBe("blocked");
    });
    it("the pilot restores into the pilot's own ports and network without conflicts on a clean target", () => {
        const p = run(kumaInput((i) => { i.mappings.sqlite = {"uptime-kuma": {volume: "uptime-kuma_data", relative_path: "kuma.db"}}; }));
        expect(p.decisions).toEqual([]);
        expect(p.compose_findings).toEqual([]);
    });
});

describe("matrix 14: unmapped artifacts, multi-channel, restic", () => {
    it("an artifact with no source link is staged, needs approval, flagged", () => {
        const p = run(planInput((i) => { i.artifacts.push(art(77, null, "bind", "files")); }));
        const a = act(p, "stage_only");
        expect(a).toMatchObject({op: "stage_only", risk: "needs_approval", reasons: ["artifact_unmapped"], resource_key: `artifact:${u(77)}`});
        expect(decision(p, "artifact_unmapped")[0].flagged).toBe(true);
    });
    it("several artifacts of one resource: one action, non-local first, expect from the first candidate", () => {
        const p = run(planInput((i) => {
            i.artifacts.push(art(81, "volume:app_data", "volume", "docker-volume", {channel_kind: "local", channel_id: u(901), plaintext_sha256: H("1")}), art(82, "volume:app_data", "volume", "docker-volume", {channel_kind: "s3", channel_id: u(902), plaintext_sha256: H("2")}));
        }));
        const vols = p.actions.filter((a) => a.kind === "restore_volume");
        expect(vols).toHaveLength(1);
        expect(vols[0].artifact_ids).toEqual([u(12), u(82), u(81)]);
        expect(vols[0].expect.plaintext_sha256).toBe(H("2"));
    });
    it("restic payload first ⇒ reason restic_payload_credential and null expect", () => {
        const p = run(planInput((i) => { i.artifacts[1] = art(12, "volume:app_data", "volume", "docker-volume", {archive_kind: "restic_snapshot", plaintext_sha256: null, plaintext_size: null}); }));
        const a = act(p, "restore_volume");
        expect(a?.reasons).toContain("restic_payload_credential");
        expect(a?.expect).toEqual({plaintext_sha256: null, plaintext_size: null});
        expect(p.outcome).toBe("ready");
    });
    it("an optional resource is skipped, a missing optional artifact too", () => {
        const p = run(planInput((i) => { i.artifacts[2].required = false; }));
        expect(act(p, "restore_db_dump")).toMatchObject({op: "skip", reasons: ["optional_artifact"]});
        const q = run(planInput((i) => { i.artifacts[2].required = false; i.artifacts[2].presence = "missing"; }));
        expect(act(q, "restore_db_dump")).toMatchObject({op: "skip"});
        expect(q.outcome).toBe("ready");
    });
});

describe("matrix 15: manifest / inventory / RP state", () => {
    it("manifest_sha256 null ⇒ manifest_unbound", () => { expect(run(planInput((i) => { i.rp.manifest_sha256 = null; })).blockers).toContain("manifest_unbound"); });
    it("inventory hash mismatch ⇒ inventory_mismatch; no inventory ⇒ inventory_missing (new/existing) but not for selective", () => {
        expect(run(planInput((i) => { i.rp.inventory_hash = H("f"); })).blockers).toContain("inventory_mismatch");
        expect(run(planInput(undefined, null)).blockers).toContain("inventory_missing");
        expect(run(planInput((i) => { i.mode = "selective"; i.mappings.select = ["volume:app_data"]; }, null)).blockers).toEqual([]);
        const q = run(planInput(undefined, null));
        expect(q.secrets).toEqual([]);
        expect(q.compose_findings).toEqual([]);
    });
    it("a required artifact that is not present ⇒ required_artifact_missing", () => {
        const p = run(planInput((i) => { i.artifacts[1].presence = "missing"; }));
        expect(p.blockers).toContain("required_artifact_missing");
        expect(act(p, "restore_volume")).toBeUndefined();
    });
    it.each([["incomplete"], ["pending_verification"], ["failed"]] as const)("RP status %s ⇒ refusal rp_not_verified", (s) => { expect(refusal(planInput((i) => { i.rp.rp_status = s; }))).toBe("rp_not_verified"); });
    it("purged ⇒ rp_purged; no compose artifact ⇒ compose_not_in_backup", () => {
        expect(refusal(planInput((i) => { i.rp.purged = true; }))).toBe("rp_purged");
        expect(run(planInput((i) => { i.artifacts = i.artifacts.slice(1); })).blockers).toContain("compose_not_in_backup");
    });
});

describe("matrix 16: target enrolment + capabilities", () => {
    it.each([
        ["archived", (i: PlanInputV1) => { i.target.archived = true; }, "target_agent_archived"],
        ["not enrolled", (i: PlanInputV1) => { i.target.enrollment = null; }, "target_not_enrolled"],
        ["revoked", (i: PlanInputV1) => { i.target.enrollment!.revoked = true; }, "target_revoked"],
        ["disabled", (i: PlanInputV1) => { i.target.enrollment!.enabled = false; }, "target_channel_disabled"],
    ])("%s ⇒ %s", (_n, mut, code) => {
        const p = run(planInput(mut));
        expect(p.blockers).toContain(code);
        expect(p.preconditions.find((x) => x.code === "target_enrolled")).toMatchObject({state: "unmet", reason: code});
        expect(p.outcome).toBe("blocked");
    });
    it("restore.target.v1 missing ⇒ target_capability_missing (every real plan until W17 ships); compose.render.v1 missing too", () => {
        const p = run(planInput((i) => { i.target.enrollment!.capabilities = ["channel.v1"]; }));
        expect(p.blockers).toContain("target_capability_missing");
        expect(p.preconditions.filter((x) => x.state === "unmet").map((x) => x.code)).toEqual(["target_capability_restore", "target_capability_compose"]);
        const q = run(planInput((i) => { i.target.enrollment!.capabilities = ["restore.target.v1"]; }));
        expect(q.preconditions.find((x) => x.code === "target_capability_compose")?.state).toBe("unmet");
    });
});

describe("matrix 17: secrets (names only)", () => {
    it("compose present ⇒ restore, unflagged; absent ⇒ require_input flagged", () => {
        const p = run(planInput());
        expect(p.secrets.every((s) => s.class === "restore" && !s.flagged)).toBe(true);
        expect(p.secrets.map((s) => `${s.service}/${s.key}/${s.origin}`)).toEqual(["web/A/env_file", "web/A/service_env"]);
        const q = run(planInput((i) => { i.mode = "selective"; i.mappings.select = ["volume:app_data"]; }));
        expect(q.secrets.every((s) => s.class === "require_input" && s.flagged)).toBe(true);
    });
    it("an env file not covered by any restored artifact ⇒ require_input; covered by `env:<path>` ⇒ restore", () => {
        const inv = cleanInventory({env_files: [{path_hint: "/srv/elsewhere.env", key_names: ["TOKEN"], referenced_by: ["web"]}]});
        const p = run(planInput(undefined, inv));
        expect(p.secrets.find((s) => s.origin === "env_file")).toMatchObject({class: "require_input", flagged: true, key: "TOKEN"});
        const q = run(planInput((i) => { i.artifacts[0].source!.covers_keys = ["env:/srv/elsewhere.env"]; }, inv));
        expect(q.secrets.find((s) => s.origin === "env_file")).toMatchObject({class: "restore", flagged: false});
    });
});

describe("matrix 18: compose findings are informational", () => {
    it("privileged / host network / docker.sock / bind outside root are listed and never change outcome", () => {
        const base = cleanInventory();
        const inv = cleanInventory({
            services: [{...base.services[0], privileged: true, network_mode: "host", mounts: ["m:0000000000000001", "m:00000000000000dd"]}],
            mounts: [base.mounts[0], {id: "m:00000000000000dd", kind: "bind", destination: "/var/run/docker.sock", host_path_hint: "/var/run/docker.sock", rw: true, consumers: ["web"], ownership: "unknown"}],
        });
        const p = run(planInput(undefined, inv));
        expect(p.compose_findings.map((f) => f.rule_id)).toEqual(["bind_outside_root", "docker_sock", "network_mode_host", "privileged"]);
        expect(p.compose_findings.every((f) => f.informational && f.service === "web")).toBe(true);
        expect(p.compose_findings_basis).toBe("inventory");
        expect(p.outcome).toBe("ready");
        expect(p.blockers).toEqual([]);
    });
});

describe("matrix 19: several environments on the target agent", () => {
    it("test + production ⇒ production (strictest wins)", () => {
        const p = run(planInput((i) => { i.target.environments = [{id: u(71), name: "t", host_role: "test", allowed_path_roots: [], facts_fresh: true}, {id: u(72), name: "p", host_role: "production", allowed_path_roots: [], facts_fresh: true}]; }));
        expect(p.target.host_role).toBe("production");
        expect(p.target.host_role_source).toBe("environment");
        expect(p.target.environment_ids).toEqual([u(71), u(72)]);
        expect(p.approvals_required[0].kind).toBe("production_target");
    });
    it("a single test environment needs no production approval for a plain restore ", () => {
        const p = run(planInput((i) => { i.target.environments[0].host_role = "test"; }));
        expect(p.approvals_required).toEqual([]);
        expect(p.target.host_role).toBe("test");
    });
    it("stale environment facts ⇒ target_facts_fresh deferred with target_facts_stale", () => {
        const p = run(planInput((i) => { i.target.environments[0].facts_fresh = false; }));
        expect(p.preconditions.find((x) => x.code === "target_facts_fresh")).toMatchObject({state: "deferred", reason: "target_facts_stale"});
    });
});

describe("misc", () => {
    it("action ids are stable and unique; orders are 1..n", () => {
        const p = run(kumaInput());
        expect(new Set(p.actions.map((a) => a.id)).size).toBe(p.actions.length);
        expect(p.actions.map((a) => a.id)).toEqual(run(kumaInput()).actions.map((a) => a.id));
        expect(p.actions.every((a) => /^a[0-9a-f]{12}$/.test(a.id))).toBe(true);
    });
    it("more than 2000 actions fail the strict schema (oversize plans are rejected, not truncated)", () => {
        expect(() => planRestore(planInput((i) => { i.artifacts = Array.from({length: 2001}, (_, k) => art(1000 + k, `volume:v${k}`, "volume", "docker-volume")); }))).toThrow();
    });
});
