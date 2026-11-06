import {z} from "zod";

/**
 * Allow-list response schemas for the pinned Arcane contract (v2.17.3, ADR-002). zod objects STRIP unknown keys, so
 * anything not named here — notably `config.env`, `environment` values, `apiUrl`, file bytes, IP/MAC addresses — never
 * leaves the parser (A5). Fields are lenient (optional/nullable) except identities, so an additive Arcane change does not
 * break discovery; `contract` tests prove every key named here exists in the pinned OpenAPI schema.
 */
const str = z.string();
const optStr = z.string().nullish().transform((v) => v ?? null);
const optBool = (d = false) => z.boolean().nullish().transform((v) => v ?? d);
const optNum = z.number().nullish().transform((v) => v ?? null);
const labels = z.record(z.string(), z.string()).nullish().transform((v) => v ?? {});
const strArray = z.array(z.string()).nullish().transform((v) => v ?? []);

export const PaginationSchema = z.object({
    currentPage: z.number().optional(),
    itemsPerPage: z.number().optional(),
    totalItems: z.number().optional(),
    totalPages: z.number().optional(),
    grandTotalItems: z.number().optional(),
});

export const page = <T extends z.ZodType>(item: T) =>
    z.object({success: z.boolean().optional(), data: z.array(item).nullish().transform((v) => v ?? []), pagination: PaginationSchema.optional()});

export const EnvironmentItem = z.object({
    id: str, name: str, status: optStr.transform((v) => v ?? "unknown"), enabled: optBool(), isEdge: optBool(), lastSeen: optStr,
    // apiUrl intentionally NOT declared
});

export const ProjectItem = z.object({
    id: str, name: str, dirName: optStr, path: optStr, status: optStr.transform((v) => v ?? "unknown"), serviceCount: optNum, runningCount: optNum,
    isArchived: optBool(), hasBuildDirective: optBool(),
    runtimeServices: z.array(z.object({name: str, containerName: optStr, containerId: optStr, image: optStr, status: optStr})).nullish().transform((v) => v ?? []),
});

export const ContainerItem = z.object({
    id: str,
    names: strArray,
    image: str,
    imageId: optStr,
    state: str,
    status: optStr,
    labels,
    mounts: z.array(z.object({type: str, name: optStr, source: optStr, destination: str, rw: optBool(true)})).nullish().transform((v) => v ?? []),
    networkSettings: z.object({networks: z.record(z.string(), z.unknown()).nullish()}).nullish(),
    hostConfig: z.object({privileged: optBool(), networkMode: optStr}).nullish(),
    ports: z.array(z.object({privatePort: z.number(), publicPort: optNum, type: z.string().default("tcp")})).nullish().transform((v) => v ?? []),
});

export const VolumeItem = z.object({
    name: str, driver: optStr.transform((v) => v ?? "local"), mountpoint: optStr, labels, inUse: optBool(), containers: strArray, size: optNum,
});

export const NetworkItem = z.object({
    id: str, name: str, driver: optStr.transform((v) => v ?? "bridge"), scope: optStr, labels, inUse: optBool(), isDefault: optBool(),
});

export const ImageItem = z.object({
    id: str, repoTags: strArray, repoDigests: strArray, created: optNum, size: optNum, inUse: optBool(),
});

/** `GET …/projects/{pid}/compose` (tier 2). `services[].environment` carries RESOLVED VALUES: only the keys survive. */
const envNames = z
    .union([z.record(z.string(), z.unknown()), z.array(z.string())])
    .nullish()
    .transform((v) => (!v ? [] : Array.isArray(v) ? v.map((e) => e.split("=")[0]).filter(Boolean) : Object.keys(v)));
export const ComposeResponse = z.object({
    data: z.object({
        id: str,
        composeContent: str,
        composeFileName: optStr,
        overrideContent: optStr,
        overrideFileName: optStr,
        services: z
            .array(z.object({name: optStr, image: optStr, environment: envNames}))
            .nullish()
            .transform((v) => (v ?? []).map((s) => ({name: s.name, image: s.image, environmentNames: s.environment}))),
    }),
});

/** `GET /auth/me/api-keys` — the OWNER's keys; the service keeps only the row that is its own. */
export const ApiKeyRow = z.object({
    id: str, name: optStr, keyPrefix: str, kind: optStr,
    permissions: z.array(z.object({permission: str, environmentId: z.string().nullish().transform((v) => v ?? null)})).nullish().transform((v) => v ?? []),
});
export type ApiKeyRowT = z.infer<typeof ApiKeyRow>;

/** `GET /version` (unauthenticated): accepts the bare object or a `data` wrapper. The lab reports `v2.17.3`: the leading `v` is dropped (observed W05). */
export const VersionResponse = z
    .union([z.object({currentVersion: str}), z.object({data: z.object({currentVersion: str})})])
    .transform((v) => ("data" in v ? v.data.currentVersion : v.currentVersion).trim().replace(/^v/i, ""));
