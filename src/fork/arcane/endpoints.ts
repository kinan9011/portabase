/**
 * EVERY request the Arcane client can make (W05). GET only — there is no `method` field on purpose; the transport itself
 * only issues GET. `cap` = capability id in `dev/fork-lab/arcane/capability-map.json`; `tier` 1 = in the list-only minimum
 * key, 2 = opt-in (`projects:read`). The contract test proves each entry exists in the pinned OpenAPI as a GET with the
 * same path template and the permission recorded in the capability map. Forbidden endpoints (`containers/{id}`,
 * `volumes/{name}`, `workspace/file`, anything POST) are absent and a test asserts they cannot be built.
 */
export const ARCANE_PINNED_VERSION = "2.17.3";
/** sha256 of the pinned OpenAPI document (`dev/fork-lab/arcane/openapi.v2.17.3.json.sha256`, test-checked); recorded in every inventory (`source.openapi_sha256`). */
export const ARCANE_OPENAPI_SHA256 = "68912259415d5cc1d0661fd68db05661dbb0991484653ef85d8c22d91666d9e1";
export const API_PREFIX = "/api";
export const PAGE_LIMIT = 100;
export const MAX_PAGES = 100;

export const ENDPOINTS = {
    version: {template: "/version", cap: "version", tier: 1},
    health: {template: "/health", cap: "health", tier: 1},
    ownKeys: {template: "/auth/me/api-keys", cap: "auth.me.api-keys", tier: 1},
    environments: {template: "/environments", cap: "environments.list", tier: 1},
    projects: {template: "/environments/{id}/projects", cap: "projects.list", tier: 1},
    projectCompose: {template: "/environments/{id}/projects/{projectId}/compose", cap: "projects.compose", tier: 2},
    containers: {template: "/environments/{id}/containers", cap: "containers.list", tier: 1},
    volumes: {template: "/environments/{id}/volumes", cap: "volumes.list", tier: 1},
    networks: {template: "/environments/{id}/networks", cap: "networks.list", tier: 1},
    images: {template: "/environments/{id}/images", cap: "images.list", tier: 1},
} as const satisfies Record<string, {template: string; cap: string; tier: 1 | 2}>;
export type EndpointName = keyof typeof ENDPOINTS;

/** Arcane ids are UUIDs or small ints (`0` = local); anything else could smuggle path segments. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function endpointPath(name: EndpointName, ids: {id?: string; projectId?: string} = {}): string {
    let p: string = ENDPOINTS[name].template;
    for (const [k, v] of Object.entries(ids)) {
        if (v === undefined) continue;
        if (!SAFE_ID.test(v)) throw new Error("invalid identifier");
        p = p.replace(`{${k}}`, v);
    }
    if (p.includes("{")) throw new Error("missing identifier");
    return `${API_PREFIX}${p}`;
}

/** The minimum key (ADR-002 A2): global `environments:list`; per allowed environment these env-scoped list permissions. */
export const GLOBAL_MINIMUM = ["environments:list"] as const;
export const ENV_MINIMUM = ["projects:list", "containers:list", "volumes:list", "networks:list", "images:list"] as const;
export const TIER2_PERMISSION = "projects:read";
