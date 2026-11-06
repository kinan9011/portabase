/**
 * DiscoveryProvider — the read-only inventory source behind the stacks feature (W05; consumers: W07 normaliser, W10).
 *
 * Contract (every implementation, today only Arcane — `src/fork/arcane/client.ts`):
 *  1. READ-ONLY. No method may change anything on the provider. The Arcane implementation issues `GET` only; there is no
 *     code path for another verb (see `endpoints.ts`).
 *  2. LIST-ONLY DATA. Results are allow-listed DTOs: unknown fields are dropped at the boundary; environment-variable
 *     VALUES and file/volume bytes never appear in any type here (names at most). `readProjectFiles` is the single method
 *     that can return compose YAML text; it needs the explicit tier-2 opt-in and the caller must treat the text as secret
 *     material (never log, never store in inventory — it can embed literals).
 *  3. HOST-WIDE LISTS ARE UNTRUSTED. Containers/volumes/networks/images are whatever the Docker host has; the caller
 *     filters by compose project label (`byComposeProject`) and by allow-listed environment ids. Labels (`working_dir`,
 *     `config_files`) are attacker-influenced hints (SEC-22), never paths to trust.
 *  4. SHORT-LIVED. An instance is bound to one vetted, pinned address (SEC-10): create one per action / sync run.
 *  5. ERRORS are `ArcaneError`-like with a class (`invalid_key`, `permission`, `unreachable`, `incompatible`, …) and a fixed message.
 *
 * `environmentId` is Arcane's external id (`"0"` = the manager's local Docker), validated against `^[A-Za-z0-9_-]{1,64}$`.
 */
export type DiscoveredEnvironment = {
    id: string;
    name: string;
    status: string;
    enabled: boolean;
    isEdge: boolean;
    lastSeen: string | null;
    // `apiUrl` is deliberately absent: Arcane lists every environment's URL and the fork never keeps it (B2-I2).
};

export type EnvironmentTestResult = {
    environmentId: string;
    /** Arcane's own status for the environment (`online`, `offline`, `pending`, …). */
    status: string;
    /** true ⇢ a scoped tier-1 list call on that environment succeeded (the reachability proof; no POST /test). */
    reachable: boolean;
};

export type DiscoveredProject = {
    id: string;
    name: string;
    dirName: string | null;
    path: string | null;
    status: string;
    serviceCount: number | null;
    runningCount: number | null;
    isArchived: boolean;
    hasBuildDirective: boolean;
    runtimeServices: {name: string; containerName: string | null; containerId: string | null; image: string | null; status: string | null}[];
};

export type DiscoveredContainer = {
    id: string;
    names: string[];
    image: string;
    imageId: string | null;
    state: string;
    status: string | null;
    labels: Record<string, string>;
    mounts: {type: string; name: string | null; source: string | null; destination: string; rw: boolean}[];
    /** network NAMES only (addresses are dropped). */
    networks: string[];
    privileged: boolean;
    networkMode: string | null;
    ports: {privatePort: number; publicPort: number | null; type: string}[];
};

export type DiscoveredVolume = {
    name: string;
    driver: string;
    mountpoint: string | null;
    labels: Record<string, string>;
    inUse: boolean;
    containers: string[];
    size: number | null;
};

export type DiscoveredNetwork = {
    id: string;
    name: string;
    driver: string;
    scope: string | null;
    labels: Record<string, string>;
    inUse: boolean;
    isDefault: boolean;
};

export type DiscoveredImage = {
    id: string;
    repoTags: string[];
    repoDigests: string[];
    created: number | null;
    size: number | null;
    inUse: boolean;
};

/** Tier-2 only. `composeContent`/`overrideContent` are raw text (secret material); `environmentNames` are NAMES — values are dropped. */
export type DiscoveredProjectFiles = {
    projectId: string;
    composeFileName: string | null;
    composeContent: string;
    overrideFileName: string | null;
    overrideContent: string | null;
    services: {name: string | null; image: string | null; environmentNames: string[]}[];
};

export interface DiscoveryProvider {
    listEnvironments(): Promise<DiscoveredEnvironment[]>;
    testEnvironment(environmentId: string): Promise<EnvironmentTestResult>;
    listProjects(environmentId: string): Promise<DiscoveredProject[]>;
    readProjectFiles(environmentId: string, projectId: string): Promise<DiscoveredProjectFiles>;
    listContainers(environmentId: string): Promise<DiscoveredContainer[]>;
    listVolumes(environmentId: string): Promise<DiscoveredVolume[]>;
    listNetworks(environmentId: string): Promise<DiscoveredNetwork[]>;
    listImages(environmentId: string): Promise<DiscoveredImage[]>;
}

/** The exact method set of the interface (a unit test pins it to the wave's scope list). */
export const DISCOVERY_PROVIDER_METHODS = [
    "listEnvironments", "testEnvironment", "listProjects", "readProjectFiles", "listContainers", "listVolumes", "listNetworks", "listImages",
] as const;

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** Keeps only the resources whose compose-project label equals `project` (host-wide lists are never "the stack"). */
export function byComposeProject<T extends {labels: Record<string, string>}>(items: readonly T[], project: string): T[] {
    return items.filter((i) => i.labels[COMPOSE_PROJECT_LABEL] === project);
}
