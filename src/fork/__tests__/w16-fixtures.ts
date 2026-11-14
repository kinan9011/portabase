import {contentHash, type StackInventoryV1} from "@/fork/inventory/schema";
import type {PlanInputV1} from "@/fork/restore/schema";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";

/** Deterministic, schema-valid UUIDs (zod 4 checks version + variant nibbles). */
export const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const H = (c: string): string => c.repeat(64).slice(0, 64);
export const DENY_SHA = H("d");
const EMPTY_FACTS: PlanInputV1["target"]["facts"] = {projects: [], volumes: [], networks: [], published_ports: [], bind_paths: [], inventory_hashes: [], arch: null, free_disk_bytes: null, image_platforms: null};
const EMPTY_MAPPINGS: PlanInputV1["mappings"] = {target_project: null, restore_root: "/srv/restore", volumes: null, select: null, sqlite: null};

type Art = PlanInputV1["artifacts"][number];
export function art(n: number, key: string | null, role: "compose" | "env" | "bind" | "volume" | "db", dbms: string, over: Partial<Art> = {}): Art {
    return {
        id: u(n), source_name: key ?? `orphan-${n}`, engine: dbms, archive_kind: "archive_enc", dump_format: null, encrypted: true, channel_id: u(900), channel_kind: "s3",
        plaintext_sha256: H(String(n % 10)), plaintext_size: 1000, required: true, presence: "present",
        source: key === null ? null : {role, resource_key: key, dbms, member_name: key.replace(/[^A-Za-z0-9_.-]/g, "_"), covers_keys: []},
        ...over,
    };
}

/** Valid baseline: verified RP, compose + volume + pg dump artifacts, `cleanInventory()`, enrolled target with both W17 capabilities, one production environment, empty facts. */
export function planInput(mut?: (i: PlanInputV1) => void, inv: StackInventoryV1 | null = cleanInventory()): PlanInputV1 {
    const i: PlanInputV1 = {
        planner: {version: 2, ruleset: "w16.2", deny_rules_sha256: DENY_SHA},
        purpose: "restore", mode: "new_stack", mappings: {...EMPTY_MAPPINGS},
        rp: {id: u(1), stack_id: u(2), stack_name: "app", sequence: 3, rp_status: "verified", purged: false, manifest_sha256: H("a"), manifest_sig_kid: "0123456789ab",
            verified_at: "2026-11-07T01:00:00Z", inventory_version: 1, inventory_hash: inv ? contentHash(inv) : null, consistency_level: "mixed"},
        artifacts: [
            art(11, "dir:/srv/app", "compose", "files", {source: {role: "compose", resource_key: "dir:/srv/app", dbms: "files", member_name: "compose_app", covers_keys: ["file:/srv/app/compose.yml", "env:/srv/app/stack.env", "env:implicit"]}}),
            art(12, "volume:app_data", "volume", "docker-volume"),
            art(13, "db:db", "db", "postgresql", {dump_format: "pg_custom"}),
        ],
        inventory: inv, inventory_content_hash: inv ? contentHash(inv) : null,
        stack: {id: u(2), compose_project: "app", environment_id: u(50), contains_personal_data: false, test_restore_opt_in: false, mirror_opt_in: false},
        selection: {sqlite: {}, manual_paths: []},
        target: {
            agent_id: u(60), agent_name: "restore-host", archived: false, runner_eligible: false,
            enrollment: {enabled: true, revoked: false, capabilities: ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"]},
            environments: [{id: u(70), name: "target-env", host_role: "production", allowed_path_roots: [], facts_fresh: true}],
            same_environment: false, facts: {...EMPTY_FACTS},
        },
    };
    mut?.(i);
    return i;
}

/** The pilot shape (decisions.md W14P setup): uptime-kuma, named volume `uptime-kuma_data` + sqlite `kuma.db` inside it. Hand-built, never read from the pilot. */
export function kumaInventory(): StackInventoryV1 {
    return cleanInventory({
        stack: {compose_project: "uptime-kuma", display_name: "uptime-kuma", compose_read: "arcane_compose", working_dir_hint: "/opt/stacks/uptime-kuma", config_files_hint: ["/opt/stacks/uptime-kuma/compose.yaml"]},
        services: [{name: "uptime-kuma", state: "running", image: {ref: "louislam/uptime-kuma:1.23.16", digest: `sha256:${H("e")}`, pinned: true, built_locally: false}, ports: [{target: 3001, published: 3101, protocol: "tcp"}], networks: ["uptime-kuma_default"], mounts: ["m:00000000000000aa"], env_keys: []}],
        mounts: [{id: "m:00000000000000aa", kind: "named_volume", volume_name: "uptime-kuma_data", destination: "/app/data", rw: true, consumers: ["uptime-kuma"], ownership: "stack_owned"}],
        volumes: [{name: "uptime-kuma_data", driver: "local", in_use_by: ["uptime-kuma"], ownership: "stack_owned"}],
        networks: [{name: "uptime-kuma_default", driver: "bridge", internal: false, external: false, members: ["uptime-kuma"], classification: "stack_owned"}],
        env_files: [],
    });
}
export function kumaInput(mut?: (i: PlanInputV1) => void): PlanInputV1 {
    const inv = kumaInventory();
    return planInput((i) => {
        i.rp.stack_name = "uptime-kuma";
        i.stack.compose_project = "uptime-kuma";
        i.artifacts = [
            art(21, "dir:/opt/stacks/uptime-kuma", "compose", "files"),
            art(22, "volume:uptime-kuma_data", "volume", "docker-volume"),
            art(23, "db:uptime-kuma", "db", "sqlite"),
        ];
        i.selection.sqlite = {"uptime-kuma": "/fork-sqlite/uptime-kuma/kuma.db"};
        mut?.(i);
    }, inv);
}
