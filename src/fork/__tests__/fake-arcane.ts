import http from "node:http";
import type {AddressInfo} from "node:net";

/**
 * Minimal fake Arcane (pinned v2.17.3 surface the adapter uses) for integration tests: real HTTP on 127.0.0.1, API-key check,
 * configurable key rows / version / failures. Records every request (path + presented key) so tests can prove what was sent where.
 */
export const MIN_PERMS = (env: string) => ["projects:list", "containers:list", "volumes:list", "networks:list", "images:list"].map((permission) => ({permission, environmentId: env}));
export type FakeState = {
    version: string;
    validKey: string;
    keyPrefix: string;
    keyId: string;
    grants: {permission: string; environmentId?: string | null}[];
    environments: {id: string; name: string; status: string; apiUrl: string}[];
    /** per environment id: HTTP status for the containers list (default 200). */
    containerStatus: Record<string, number>;
    forceStatus?: number;
};
export type FakeArcane = {url: string; port: number; state: FakeState; requests: {method: string; path: string; key: string | null}[]; close: () => Promise<void>};

export async function startFakeArcane(over: Partial<FakeState> = {}): Promise<FakeArcane> {
    const state: FakeState = {
        version: "2.17.3", validKey: "arc_FAKEPFX1_SECRETSECRETSECRET", keyPrefix: "arc_FAKEPFX1", keyId: "key-1",
        grants: [{permission: "environments:list", environmentId: null}, ...MIN_PERMS("0")],
        environments: [
            {id: "0", name: "local", status: "online", apiUrl: "http://internal-secret-host.invalid:3552"},
            {id: "e9", name: "someone-elses-env", status: "online", apiUrl: "http://other-internal-host.invalid"},
        ],
        containerStatus: {}, ...over,
    };
    const requests: FakeArcane["requests"] = [];
    const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, {"content-type": "application/json"}); res.end(JSON.stringify(body)); };
    const srv = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const key = (req.headers["x-api-key"] as string | undefined) ?? null;
        requests.push({method: req.method ?? "?", path: url.pathname + url.search, key});
        if (state.forceStatus) return json(res, state.forceStatus, {detail: "forced"});
        if (url.pathname === "/api/version") return json(res, 200, {currentVersion: state.version, updateAvailable: false});
        if (key !== state.validKey) return json(res, 401, {detail: "invalid API key"});
        const page = (data: unknown[]) => json(res, 200, {success: true, data, pagination: {totalItems: data.length, currentPage: 1, itemsPerPage: 100, totalPages: 1}});
        if (url.pathname === "/api/auth/me/api-keys") {
            return page([
                {id: state.keyId, name: "fork", keyPrefix: state.keyPrefix, kind: "scoped", permissions: state.grants},
                {id: "owner-other", name: "admin key", keyPrefix: "arc_OTHERKEY", kind: "personal", permissions: [{permission: "containers:read"}, {permission: "apikeys:create"}]},
            ]);
        }
        if (url.pathname === "/api/environments") return page(state.environments);
        const m = /^\/api\/environments\/([^/]+)\/(containers|projects|volumes|networks|images)$/.exec(url.pathname);
        if (m) {
            const st = m[2] === "containers" ? state.containerStatus[m[1]] ?? 200 : 200;
            if (st !== 200) return json(res, st, {detail: st === 403 ? "permission denied: containers:list" : "Remote environment rejected the manager's credentials"});
            return page([]);
        }
        return json(res, 404, {detail: "not found"});
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    return {url: `http://127.0.0.1:${port}`, port, state, requests, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); })};
}
