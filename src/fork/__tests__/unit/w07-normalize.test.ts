import {describe, expect, it} from "vitest";
import {discoveredFrom, LAB_PROXY} from "@/fork/__tests__/discovered-fixtures";
import {canonicalJson} from "@/fork/canonical";
import type {DiscoveredContainer} from "@/fork/discovery/provider";
import {parseBackupHints, safeAbsPath} from "@/fork/inventory/labels";
import {type NormalizeInput, normalizeEnvironment } from "@/fork/inventory/normalize";

const CONN = "00000000-0000-4000-8000-000000000001";
const base = async (over: Partial<NormalizeInput> = {}): Promise<NormalizeInput> => {
    const l = await discoveredFrom();
    return {connectionId: CONN, environmentId: "0", arcaneVersion: "2.17.3", capturedAt: new Date("2026-11-07T00:00:00Z"), ...l, networks: [...l.networks, LAB_PROXY], ...over};
};
const ctr = (over: Partial<DiscoveredContainer> & {labels?: Record<string, string>} = {}): DiscoveredContainer => ({
    id: "c".repeat(64), names: ["x"], image: "nginx:1", imageId: null, state: "running", status: null, mounts: [], networks: [], privileged: false, networkMode: null, ports: [],
    ...over, labels: {"com.docker.compose.project": "demo", "com.docker.compose.service": "web", ...(over.labels ?? {})},
});
const one = async (c: Partial<DiscoveredContainer>, extra: Partial<NormalizeInput> = {}) => {
    const r = normalizeEnvironment({...(await base({containers: [], volumes: [], networks: [], images: [], projects: []})), containers: [ctr(c)], ...extra});
    return r;
};

describe("lab demo stack (fixtures through the real client mapping)", () => {
    it("one stack forklab-demo with db + web, correct classification", async () => {
        const r = normalizeEnvironment(await base());
        expect(r.rejected).toEqual([]);
        const s = r.stacks.find((x) => x.composeProject === "forklab-demo");
        expect(s).toBeDefined();
        const inv = s!.inventory;
        expect(inv.services.map((x) => x.name)).toEqual(["db", "web"]);
        expect(inv.services.map((x) => x.state)).toEqual(["running", "running"]);
        expect(s!.runtimeState).toBe("running");
        const db = inv.services.find((x) => x.name === "db")!;
        expect(db.image.pinned).toBe(true);
        expect(db.image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(db.database_hint).toEqual({engine: "postgresql", basis: "image"});
        expect(db.backup_hints).toBeUndefined();
        expect(db.depends_on).toBeUndefined();
        const web = inv.services.find((x) => x.name === "web")!;
        expect(web.depends_on).toEqual(["db"]);
        expect(web.ports).toContainEqual({target: 8080, published: 18080, protocol: "tcp"});
        expect(inv.stack).toMatchObject({compose_project: "forklab-demo", display_name: "forklab-demo", compose_read: "none", working_dir_hint: "/srv/fork-lab/demo-stack", config_files_hint: ["/srv/fork-lab/demo-stack/compose.override.yml"]});
        // mounts: named volumes, binds, one anonymous volume (the Postgres image VOLUME in `web`)
        const kinds = inv.mounts.map((m) => `${m.kind}:${m.volume_name ?? m.host_path_hint}`).sort();
        expect(kinds).toEqual([
            "anonymous_volume:bc912505cd5f", "bind:/srv/fork-lab/demo-stack/uploads", "bind:/srv/fork-lab/demo-stack/web/handle.sh", "bind:/srv/fork-lab/demo-stack/web/serve.sh",
            "named_volume:forklab-demo_appdata", "named_volume:forklab-demo_pgdata",
        ]);
        expect(inv.mounts.find((m) => m.host_path_hint?.endsWith("/uploads"))).toMatchObject({rw: false, ownership: "unknown", consumers: ["web"]});
        expect(inv.mounts.find((m) => m.volume_name === "forklab-demo_pgdata")).toMatchObject({ownership: "stack_owned", consumers: ["db"], rw: true});
        expect(inv.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["anonymous-volume-not-backed-up", "bind-mount-host-path", "network-shared-external", "compose-definition-not-read"]));
        expect(inv.volumes.map((v) => v.name)).toEqual(["forklab-demo_appdata", "forklab-demo_pgdata"]);
        expect(inv.volumes.find((v) => v.name === "forklab-demo_pgdata")).toMatchObject({in_use_by: ["db"], ownership: "stack_owned"});
        // networks: internal is stack-owned; lab_proxy is flagged shared/external (and listed as an external dependency)
        expect(inv.networks.find((n) => n.name === "forklab-demo_internal")).toMatchObject({classification: "stack_owned", external: false, members: ["db", "web"]});
        expect(inv.networks.find((n) => n.name === "lab_proxy")).toMatchObject({classification: "shared_external", external: true, members: ["web"]});
        expect(inv.external_dependencies).toContainEqual({kind: "network", name: "lab_proxy", note_key: "network-external-shared"});
        expect(inv.provenance["/services/0/image/digest"]).toBe("arcane_list");
        expect(r.unmanagedContainers).toBe(0);
    });
    it("a network seen only as a membership (no record, nobody else on it) is `manual`", async () => {
        const r = normalizeEnvironment(await base({networks: (await base()).networks.filter((n) => n.name !== "lab_proxy")}));
        expect(r.stacks[0].inventory.networks.find((n) => n.name === "lab_proxy")?.classification).toBe("manual");
    });
    it("same facts in any order ⇒ same canonical hash; any real change ⇒ different hash; captured_at/warnings do not count", async () => {
        const b = await base();
        const a = normalizeEnvironment(b).stacks[0];
        const shuffled = normalizeEnvironment({...b, containers: [...b.containers].reverse().map((c) => ({...c, mounts: [...c.mounts].reverse(), networks: [...c.networks].reverse(), ports: [...c.ports].reverse()})), volumes: [...b.volumes].reverse(), networks: [...b.networks].reverse(), capturedAt: new Date("2030-01-01T00:00:00Z")}).stacks[0];
        expect(shuffled.contentHash).toBe(a.contentHash);
        expect(canonicalJson({...shuffled.inventory, captured_at: "x", warnings: []})).toBe(canonicalJson({...a.inventory, captured_at: "x", warnings: []}));
        const changed = normalizeEnvironment({...b, containers: b.containers.map((c) => (c.names[0] === "forklab-demo-web-1" ? {...c, image: "postgres:17-alpine"} : c))}).stacks[0];
        expect(changed.contentHash).not.toBe(a.contentHash);
    });
    it("host-wide lists: containers without a compose label are not stacks; one-off containers are ignored", async () => {
        const b = await base();
        const r = normalizeEnvironment({...b, containers: [...b.containers, {...ctr({id: "d".repeat(64)}), labels: {}}, {...ctr({id: "e".repeat(64)}), labels: {"com.docker.compose.project": "demo", "com.docker.compose.service": "job", "com.docker.compose.oneoff": "True"}}]});
        expect(r.unmanagedContainers).toBe(1);
        expect(r.ignoredOneOff).toBe(1);
        expect(r.stacks.map((s) => s.composeProject)).toEqual(["forklab-demo"]);
    });
});

describe("labels are untrusted (SEC-22)", () => {
    it("hint grammar: portabase.backup.* booleans/enum + Offen alias; invalid values ignored and never echoed", () => {
        expect(parseBackupHints({"portabase.backup.stop": "true", "portabase.backup.exclude": "FALSE", "portabase.backup.consistency": " Dump "})).toEqual({hints: {stop: true, exclude: false, consistency: "dump"}, ignored: 0});
        expect(parseBackupHints({"docker-volume-backup.stop-during-backup": "group-a"}).hints).toEqual({stop: true});
        expect(parseBackupHints({"docker-volume-backup.stop-during-backup": "false"}).hints).toEqual({stop: false});
        expect(parseBackupHints({"portabase.backup.stop": "false", "docker-volume-backup.stop-during-backup": "x"}).hints).toEqual({stop: false}); // portabase key wins
        const bad = parseBackupHints({"portabase.backup.stop": "rm -rf /", "portabase.backup.exclude": "yes", "portabase.backup.consistency": "<script>alert(1)</script>", "portabase.backup.other": "x"});
        expect(bad).toEqual({hints: undefined, ignored: 3});
    });
    it("hints land in the inventory per service (provenance container_label); `stop` is data only", async () => {
        const r = await one({labels: {"portabase.backup.stop": "true", "portabase.backup.consistency": "crash"}});
        expect(r.stacks[0].inventory.services[0].backup_hints).toEqual({stop: true, consistency: "crash"});
        expect(r.stacks[0].inventory.provenance["/services/0/backup_hints"]).toBe("container_label");
    });
    it("volume labels carry hints too", async () => {
        const b = await base();
        const r = normalizeEnvironment({...b, volumes: b.volumes.map((v) => (v.name === "forklab-demo_pgdata" ? {...v, labels: {...v.labels, "portabase.backup.exclude": "true"}} : v))});
        expect(r.stacks[0].inventory.volumes.find((v) => v.name === "forklab-demo_pgdata")?.backup_hints).toEqual({exclude: true});
    });
    it("secret-bearing / arbitrary labels never reach the inventory (only compose keys + hint keys are read)", async () => {
        const CANARY = "CANARY-label-secret-7f3a";
        const r = await one({labels: {"com.example.password": CANARY, "traefik.http.routers.x.rule": CANARY, "db.url": `postgres://u:${CANARY}@h/db`, "portabase.backup.stop": CANARY}});
        expect(JSON.stringify(r)).not.toContain(CANARY);
    });
    it("path labels: traversal / relative / NUL / control chars are rejected (hint omitted + warning), host mounts too", async () => {
        for (const wd of ["../../etc", "relative/dir", "/ok/../escape", "/a\u0000b", "/x".repeat(600), "C:\\win"]) {
            const r = await one({labels: {"com.docker.compose.project.working_dir": wd, "com.docker.compose.project.config_files": `${wd},/ok/compose.yml`}});
            const inv = r.stacks[0].inventory;
            expect(inv.stack.working_dir_hint, wd).toBeUndefined();
            expect(inv.stack.config_files_hint, wd).toEqual(["/ok/compose.yml"]);
            expect(inv.warnings.map((w) => w.code)).toContain("label-path-rejected");
        }
        const r = await one({mounts: [{type: "bind", name: null, source: "/srv/../root", destination: "/data", rw: true}, {type: "bind", name: null, source: "/srv/data", destination: "relative", rw: true}]});
        expect(r.stacks[0].inventory.mounts).toHaveLength(1); // destination "relative" dropped; escaping source loses its hint
        expect(r.stacks[0].inventory.mounts[0].host_path_hint).toBeUndefined();
        expect(safeAbsPath("/a//b/./c/")).toBe("/a/b/c");
        expect(safeAbsPath("/")).toBe("/");
    });
    it("a hostile compose project label never becomes a stack identity and is never echoed", async () => {
        const r = normalizeEnvironment({...(await base()), projects: [], containers: [ctr({labels: {"com.docker.compose.project": "../../x; drop table"}})]});
        expect(r.stacks).toEqual([]);
        expect(r.rejected).toEqual([{composeProject: null, code: "invalid_project"}]);
        expect(JSON.stringify(r)).not.toContain("drop table");
    });
    it("display name: control characters / over-long Arcane names fall back to the compose project", async () => {
        const b = await base();
        for (const name of ["x".repeat(129), "bad\u0007name", " padded "]) {
            const r = normalizeEnvironment({...b, projects: b.projects.map((p) => ({...p, name: "forklab-demo", dirName: name}))});
            expect(r.stacks[0].displayName).toBe("forklab-demo");
        }
    });
});

describe("limits reject, never truncate", () => {
    it("> 500 services and > 2000 mounts reject only that stack", async () => {
        const many = Array.from({length: 501}, (_, i) => ctr({id: i.toString(16).padStart(64, "0"), labels: {"com.docker.compose.service": `svc${i}`}}));
        const r = normalizeEnvironment({...(await base()), containers: [...many, ...(await base()).containers]});
        expect(r.rejected).toContainEqual({composeProject: "demo", code: "inventory_limit"});
        expect(r.stacks.map((s) => s.composeProject)).toEqual(["forklab-demo"]);
        const mounts = Array.from({length: 2001}, (_, i) => ({type: "bind", name: null, source: `/srv/d${i}`, destination: `/m${i}`, rw: true}));
        const r2 = normalizeEnvironment({...(await base()), containers: [ctr({mounts})]});
        expect(r2.rejected).toContainEqual({composeProject: "demo", code: "inventory_limit"});
    });
    it("an image ref beyond the schema limit rejects the stack as invalid", async () => {
        const r = await one({image: `registry.example/${"a".repeat(600)}`});
        expect(r.rejected).toContainEqual({composeProject: "demo", code: "inventory_invalid"});
    });
});

describe("heuristics are hints", () => {
  it("DB engine by image, then port, then sqlite by mount name", async () => {
    expect((await one({image: "docker.io/bitnami/postgresql:16"})).stacks[0].inventory.services[0].database_hint).toEqual({engine: "postgresql", basis: "image"});
    expect((await one({image: "mcr.microsoft.com/mssql/server:2022"})).stacks[0].inventory.services[0].database_hint).toEqual({engine: "mssql", basis: "image"});
    expect((await one({image: "myorg/custom:1", ports: [{privatePort: 3306, publicPort: null, type: "tcp"}]})).stacks[0].inventory.services[0].database_hint).toEqual({engine: "mysql", basis: "port"});
    expect((await one({image: "myorg/app:1", mounts: [{type: "volume", name: "app_sqlitedata", source: "/var/lib/docker/volumes/x/_data", destination: "/data", rw: true}]})).stacks[0].inventory.services[0].database_hint).toEqual({engine: "sqlite", basis: "mount"});
    expect((await one({image: "nginx:1"})).stacks[0].inventory.services[0].database_hint).toBeUndefined();
  });
  it("special network modes are kept (deny-list input); ordinary ones are not; privileged is flagged", async () => {
    const s = (await one({networkMode: "host", privileged: true})).stacks[0].inventory;
    expect(s.services[0]).toMatchObject({network_mode: "host", privileged: true});
    expect(s.warnings.map((w) => w.code)).toContain("privileged-service");
    expect((await one({networkMode: "forklab-demo_internal"})).stacks[0].inventory.services[0].network_mode).toBeUndefined();
  });
});
