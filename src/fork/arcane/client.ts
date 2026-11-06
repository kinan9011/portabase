import type {z} from "zod";
import {ArcaneError, permissionFromDetail} from "@/fork/arcane/errors";
import {
    ApiKeyRow, ComposeResponse, ContainerItem, EnvironmentItem, ImageItem, NetworkItem, page, ProjectItem, VersionResponse, VolumeItem,
    type ApiKeyRowT,
} from "@/fork/arcane/schemas";
import {endpointPath, MAX_PAGES, PAGE_LIMIT, SAFE_ID, TIER2_PERMISSION, type EndpointName} from "@/fork/arcane/endpoints";
import type {
    DiscoveredContainer, DiscoveredEnvironment, DiscoveredImage, DiscoveredNetwork, DiscoveredProject, DiscoveredProjectFiles, DiscoveredVolume,
    DiscoveryProvider, EnvironmentTestResult,
} from "@/fork/discovery/provider";
import {parseAllowlist, UrlGuardError, vetBaseUrl, type Allowlist, type Resolver, type VettedTarget} from "@/fork/net/guard";
import {pinnedGet, TransportError, type PinnedRequestInit, type PinnedResponse} from "@/fork/net/pinned-request";

/**
 * Read-only Arcane client (W05). GET only through `pinnedGet` (vetted, pinned address; no redirects; TLS verify on),
 * `X-API-Key` header, 10 s timeout, bounded retry (network/timeout/5xx: 2 retries with 250 ms / 1 s back-off; 429: honours
 * `Retry-After` up to 10 s), `limit=100` + offset pagination. It never logs and never puts a header, URL or body into an
 * error. One instance = one vetted address: create it per action / sync run.
 */
export type ArcaneClientOptions = {
    baseUrl: string;
    /** the plaintext key; the caller obtained it from `readConnectionApiKey` and never keeps it longer than the call. */
    apiKey: string;
    allowlist?: Allowlist;
    resolve?: Resolver;
    tlsInsecure?: boolean;
    /** tier-2 opt-in (`projects:read`); `readProjectFiles` refuses without it, before any network call. */
    allowProjectsRead?: boolean;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** test seam: replaces the network transport. */
    transport?: (init: PinnedRequestInit) => Promise<PinnedResponse>;
};

const BACKOFF_MS = [250, 1000];
const MAX_RETRY_AFTER_S = 10;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ArcaneClient implements DiscoveryProvider {
    private constructor(
        readonly target: VettedTarget,
        private readonly apiKey: string,
        private readonly o: ArcaneClientOptions,
    ) {}

    /** Vets the URL once (SSRF guard) and pins the resulting address for the lifetime of the client. */
    static async create(o: ArcaneClientOptions): Promise<ArcaneClient> {
        try {
            const target = await vetBaseUrl(o.baseUrl, {allowlist: o.allowlist ?? parseAllowlist(""), resolve: o.resolve});
            return new ArcaneClient(target, o.apiKey, o);
        } catch (e) {
            if (e instanceof UrlGuardError) throw new ArcaneError("blocked_url", {message: e.message});
            throw e;
        }
    }

    // ---- transport ------------------------------------------------------------------------------------------------
    private async get<S extends z.ZodType>(name: EndpointName, ids: {id?: string; projectId?: string}, schema: S, query: Record<string, string | number> = {}, auth = true): Promise<z.output<S>> {
        const qs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
        const path = endpointPath(name, ids) + (qs ? `?${qs}` : "");
        const send = this.o.transport ?? pinnedGet;
        const sleep = this.o.sleep ?? defaultSleep;
        let last: ArcaneError | null = null;
        for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
            let res: PinnedResponse;
            try {
                res = await send({target: this.target, path, headers: auth ? {"x-api-key": this.apiKey} : {}, timeoutMs: this.o.timeoutMs, tlsInsecure: this.o.tlsInsecure});
            } catch (e) {
                if (!(e instanceof TransportError)) throw new ArcaneError("unreachable");
                if (e.code === "tls") throw new ArcaneError("tls");
                if (e.code === "network" || e.code === "timeout") {
                    last = new ArcaneError("unreachable");
                    if (attempt < BACKOFF_MS.length) { await sleep(BACKOFF_MS[attempt]); continue; }
                    throw last;
                }
                throw new ArcaneError("bad_response"); // redirect / too_large / bad_content_type
            }
            const s = res.status;
            if (s >= 200 && s < 300) {
                let json: unknown;
                try { json = JSON.parse(res.body); } catch { throw new ArcaneError("bad_response", {status: s}); }
                const parsed = schema.safeParse(json);
                if (!parsed.success) throw new ArcaneError("bad_response", {status: s});
                return parsed.data;
            }
            if (s === 401) throw new ArcaneError("invalid_key", {status: 401});
            if (s === 403) { const permission = permissionFromDetail(res.body); throw new ArcaneError("permission", {status: 403, permission, message: permission ? `The Arcane key lacks the permission ${permission}.` : undefined}); }
            if (s === 404) throw new ArcaneError("not_found", {status: 404});
            if (s === 429) {
                const ra = Number(res.headers["retry-after"]);
                const waitS = Number.isFinite(ra) && ra >= 0 ? ra : 1;
                last = new ArcaneError("rate_limited", {status: 429});
                if (attempt < BACKOFF_MS.length && waitS <= MAX_RETRY_AFTER_S) { await sleep(waitS * 1000); continue; }
                throw last;
            }
            if (s >= 500) {
                last = new ArcaneError("unreachable", {status: s});
                if (attempt < BACKOFF_MS.length) { await sleep(BACKOFF_MS[attempt]); continue; }
                throw last;
            }
            throw new ArcaneError("bad_response", {status: s});
        }
        throw last ?? new ArcaneError("unreachable");
    }

    private async listAll<S extends z.ZodType>(name: EndpointName, ids: {id?: string}, item: S): Promise<z.output<S>[]> {
        const out: z.output<S>[] = [];
        const schema = page(item);
        for (let p = 0; p < MAX_PAGES; p++) {
            const start = p * PAGE_LIMIT;
            const r = await this.get(name, ids, schema, {limit: PAGE_LIMIT, start});
            out.push(...(r.data as z.output<S>[]));
            const total = r.pagination?.totalItems;
            if (r.data.length < PAGE_LIMIT || (typeof total === "number" && start + r.data.length >= total)) return out;
        }
        throw new ArcaneError("bad_response", {message: "Arcane returned more pages than the adapter will read."});
    }

    private env(id: string) {
        if (!SAFE_ID.test(id)) throw new ArcaneError("not_found", {message: "Invalid environment id."});
        return {id};
    }

    // ---- connection checks (not part of DiscoveryProvider) --------------------------------------------------------------
    /** Unauthenticated `GET /version` → `currentVersion`. */
    getVersion(): Promise<string> {
        return this.get("version", {}, VersionResponse, {}, false);
    }

    /** `GET /auth/me/api-keys` — the owner's keys (permission self-test input; the caller keeps only its own row). */
    async listOwnerKeys(): Promise<ApiKeyRowT[]> {
        const r = await this.get("ownKeys", {}, page(ApiKeyRow));
        return r.data;
    }

    // ---- DiscoveryProvider -----------------------------------------------------------------------------------------------
    async listEnvironments(): Promise<DiscoveredEnvironment[]> {
        const rows = await this.listAll("environments", {}, EnvironmentItem);
        return rows.map((e) => ({id: e.id, name: e.name, status: e.status, enabled: e.enabled, isEdge: e.isEdge, lastSeen: e.lastSeen}));
    }

    async testEnvironment(environmentId: string): Promise<EnvironmentTestResult> {
        const ids = this.env(environmentId);
        const envs = await this.listEnvironments();
        const found = envs.find((e) => e.id === environmentId);
        if (!found) throw new ArcaneError("not_found", {message: "That environment is not visible to the key."});
        // Reachability proof = one scoped tier-1 list call (POST /environments/{id}/test needs environments:read and is a POST).
        await this.get("containers", ids, page(ContainerItem), {limit: 1, start: 0});
        return {environmentId, status: found.status, reachable: true};
    }

    async listProjects(environmentId: string): Promise<DiscoveredProject[]> {
        const rows = await this.listAll("projects", this.env(environmentId), ProjectItem);
        return rows.map((p) => ({
            id: p.id, name: p.name, dirName: p.dirName, path: p.path, status: p.status, serviceCount: p.serviceCount, runningCount: p.runningCount,
            isArchived: p.isArchived, hasBuildDirective: p.hasBuildDirective, runtimeServices: p.runtimeServices,
        }));
    }

    async readProjectFiles(environmentId: string, projectId: string): Promise<DiscoveredProjectFiles> {
        if (!this.o.allowProjectsRead) throw new ArcaneError("permission", {permission: TIER2_PERMISSION, message: `Reading compose files needs the opt-in ${TIER2_PERMISSION} (tier 2), which is not enabled for this connection.`});
        const r = await this.get("projectCompose", {...this.env(environmentId), projectId}, ComposeResponse);
        const d = r.data;
        return {projectId: d.id, composeFileName: d.composeFileName, composeContent: d.composeContent, overrideFileName: d.overrideFileName, overrideContent: d.overrideContent, services: d.services};
    }

    async listContainers(environmentId: string): Promise<DiscoveredContainer[]> {
        const rows = await this.listAll("containers", this.env(environmentId), ContainerItem);
        return rows.map((c) => ({
            id: c.id, names: c.names, image: c.image, imageId: c.imageId, state: c.state, status: c.status, labels: c.labels, mounts: c.mounts,
            networks: Object.keys(c.networkSettings?.networks ?? {}),
            privileged: c.hostConfig?.privileged ?? false, networkMode: c.hostConfig?.networkMode ?? null,
            ports: c.ports.map((p) => ({privatePort: p.privatePort, publicPort: p.publicPort && p.publicPort > 0 ? p.publicPort : null, type: p.type})),
        }));
    }

    async listVolumes(environmentId: string): Promise<DiscoveredVolume[]> {
        const rows = await this.listAll("volumes", this.env(environmentId), VolumeItem);
        return rows.map((v) => ({name: v.name, driver: v.driver, mountpoint: v.mountpoint, labels: v.labels, inUse: v.inUse, containers: v.containers, size: v.size}));
    }

    async listNetworks(environmentId: string): Promise<DiscoveredNetwork[]> {
        const rows = await this.listAll("networks", this.env(environmentId), NetworkItem);
        return rows.map((n) => ({id: n.id, name: n.name, driver: n.driver, scope: n.scope, labels: n.labels, inUse: n.inUse, isDefault: n.isDefault}));
    }

    async listImages(environmentId: string): Promise<DiscoveredImage[]> {
        const rows = await this.listAll("images", this.env(environmentId), ImageItem);
        return rows.map((i) => ({id: i.id, repoTags: i.repoTags, repoDigests: i.repoDigests, created: i.created, size: i.size, inUse: i.inUse}));
    }
}
