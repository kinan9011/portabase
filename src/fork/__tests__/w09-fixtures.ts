import type {StackInventoryV1} from "@/fork/inventory/schema";
import {richInventory} from "@/fork/__tests__/w08-fixtures";

/** A clean inventory: one service, one named volume, one bind under the working dir, compose read, one env file. Nothing a validator can object to except "nothing covers it yet". */
export function cleanInventory(over: Partial<StackInventoryV1> = {}): StackInventoryV1 {
    return {
        schema_version: 1,
        captured_at: "2026-11-07T01:00:00Z",
        source: {arcane_version: "v2.17.3", openapi_sha256: `sha256:${"a".repeat(64)}`, connection_id: "11111111-1111-4111-8111-111111111111", environment_id: "0"},
        stack: {compose_project: "app", display_name: "app", compose_read: "arcane_compose", working_dir_hint: "/srv/app", config_files_hint: ["/srv/app/compose.yml", "/srv/app/compose.override.yml"]},
        services: [{name: "web", state: "running", image: {ref: "nginx:1@sha256:" + "c".repeat(64), pinned: true, built_locally: false}, ports: [], networks: ["app_default"], mounts: ["m:0000000000000001", "m:0000000000000002"], env_keys: ["A"]}],
        mounts: [
            {id: "m:0000000000000001", kind: "named_volume", volume_name: "app_data", destination: "/data", rw: true, consumers: ["web"], ownership: "stack_owned"},
            {id: "m:0000000000000002", kind: "bind", destination: "/up", host_path_hint: "/srv/app/uploads", rw: true, consumers: ["web"], ownership: "unknown"},
        ],
        volumes: [{name: "app_data", driver: "local", in_use_by: ["web"], ownership: "stack_owned"}],
        networks: [{name: "app_default", driver: "bridge", internal: false, external: false, members: ["web"], classification: "stack_owned"}],
        env_files: [{path_hint: "/srv/app/stack.env", key_names: ["A"], referenced_by: ["web"]}],
        external_dependencies: [], provenance: {}, warnings: [],
        ...over,
    };
}

/** Coverage + probes that make `cleanInventory()` fully captured. */
export const FULL_COVERAGE = {
    coverage: {
        "file:/srv/app/compose.yml": "files", "file:/srv/app/compose.override.yml": "files", "env:/srv/app/stack.env": "files", "env:implicit": "files",
        "volume:app_data": "files", "mount:m:0000000000000002": "files",
    } as Record<string, "files">,
    probes: {
        "file:/srv/app/compose.yml": "readable", "file:/srv/app/compose.override.yml": "readable", "env:/srv/app/stack.env": "readable", "env:implicit": "readable", "mount:m:0000000000000002": "readable",
    } as Record<string, "readable">,
};

export {richInventory};
