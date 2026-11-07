import type {StackInventoryV1} from "@/fork/inventory/schema";

/** A lab-shaped inventory (db + web, named volumes, a bind, an anonymous volume, a stack-owned and a shared external network, database hint). Planted `canary` strings must NEVER reach a DTO or a page. */
export const CANARY = "w08-canary-9f3a7c1d-never-render";

export function richInventory(over: {project?: string; display?: string; connectionId?: string} = {}): StackInventoryV1 {
    const project = over.project ?? "forklab-demo";
    return {
        schema_version: 1,
        captured_at: "2026-11-07T01:00:00Z",
        source: {arcane_version: "v2.17.3", openapi_sha256: `sha256:${"a".repeat(64)}`, connection_id: over.connectionId ?? "11111111-1111-4111-8111-111111111111", environment_id: "0"},
        stack: {compose_project: project, display_name: over.display ?? project, compose_read: "none", working_dir_hint: "/srv/lab/demo", config_files_hint: ["/srv/lab/demo/compose.yml"]},
        services: [
            {name: "db", state: "running", container_id: "abcdef123456", image: {ref: "postgres:17@sha256:" + "b".repeat(64), pinned: true, built_locally: false}, ports: [], networks: [`${project}_internal`], mounts: ["m:0000000000000001"], env_keys: ["POSTGRES_USER", "POSTGRES_PASSWORD"], database_hint: {engine: "postgresql", basis: "image"}},
            {name: "web", state: "running", container_id: "fedcba654321", image: {ref: "demo/web:1.0", pinned: false, built_locally: true}, ports: [{target: 80, published: 18080, protocol: "tcp"}], networks: [`${project}_internal`, "lab_proxy"], mounts: ["m:0000000000000002", "m:0000000000000003", "m:0000000000000004"], env_keys: ["APP_SECRET"], privileged: false},
        ],
        mounts: [
            {id: "m:0000000000000001", kind: "named_volume", volume_name: `${project}_pgdata`, destination: "/var/lib/postgresql/data", rw: true, consumers: ["db"], ownership: "stack_owned"},
            {id: "m:0000000000000002", kind: "named_volume", volume_name: `${project}_appdata`, destination: "/app/data", rw: true, consumers: ["web"], ownership: "stack_owned"},
            {id: "m:0000000000000003", kind: "bind", destination: "/app/uploads", host_path_hint: "/srv/lab/demo/uploads", rw: false, consumers: ["web"], ownership: "unknown"},
            {id: "m:0000000000000004", kind: "anonymous_volume", destination: "/var/cache", rw: true, consumers: ["web"], ownership: "unknown"},
        ],
        volumes: [
            {name: `${project}_appdata`, driver: "local", in_use_by: ["web"], ownership: "stack_owned"},
            {name: `${project}_pgdata`, driver: "local", in_use_by: ["db"], ownership: "stack_owned"},
        ],
        networks: [
            {name: `${project}_internal`, driver: "bridge", internal: false, external: false, members: ["db", "web"], classification: "stack_owned"},
            {name: "lab_proxy", driver: "bridge", internal: false, external: true, members: ["web"], classification: "shared_external"},
        ],
        env_files: [], external_dependencies: [{kind: "network", name: "lab_proxy", note_key: "network-shared-external"}],
        provenance: {"/services/0/state": "arcane_list"},
        warnings: [
            {code: "anonymous-volume-not-backed-up", severity: "warn", path: "/mounts/3", message_key: "anonymous-volume-not-backed-up"},
            {code: "network-shared-external", severity: "warn", path: "/networks/1", message_key: "network-shared-external"},
            {code: "some-future-code", severity: "info", message_key: "some-future-code"},
        ],
    };
}
