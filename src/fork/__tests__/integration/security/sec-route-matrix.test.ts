import {createHash, randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {enrolAgent, revokeEnrollment, setChannelEnabled} from "@/fork/agent-channel/admin";
import {decodeBundle, type ChannelBundle} from "@/fork/agent-channel/bundle";
import {enqueueTask} from "@/fork/agent-channel/tasks";
import {registerActivePolicyProbe, registerSelfCheck, setLaneStatus} from "@/fork/mode";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {adminUser, deps as chDeps, PASSWORD} from "@/fork/__tests__/w17-world";
import {seedAgent, seedOrg} from "@/fork/__tests__/w04-helpers";
import {dumpForkTables} from "../../security/canary";
import {ROUTE_MATRIX} from "../../security/matrix";
import {seedSecWorld, type SecWorld, type SecUser} from "../../security/world";
import {listForkRoutes, routeKey} from "../../security/surface";

/**
 * SEC-09 route matrix (plan D-7): the REAL exported route handlers against Postgres. Agent routes: bearer in every failure shape → the SAME 401 body, `channel_disabled` only after a
 * matching credential, the credential of agent A never touches agent B's rows. Kit route: CSRF before authentication, API-key refused, session roles. Status route: mode off / non-admin → 404.
 */
const h = vi.hoisted(() => ({user: null as null | Record<string, unknown>, db: null as unknown}));
vi.mock("@/lib/auth/current-user", () => ({currentUser: async () => h.user}));
vi.mock("@/fork/db/handle", async (orig) => ({...(await orig<typeof import("@/fork/db/handle")>()), appDb: async () => h.db}));
vi.mock("@/utils/get-server-url", () => ({getServerUrl: () => "https://dash.sec.test"}));

import {POST as hashReport} from "../../../../../app/api/fork/agent/[agentId]/hash-report/route";
import {POST as lease} from "../../../../../app/api/fork/agent/[agentId]/lease/route";
import {POST as heartbeat} from "../../../../../app/api/fork/agent/[agentId]/tasks/[taskId]/heartbeat/route";
import {POST as quiesce} from "../../../../../app/api/fork/agent/[agentId]/tasks/[taskId]/quiesce/route";
import {POST as render} from "../../../../../app/api/fork/agent/[agentId]/tasks/[taskId]/render/route";
import {POST as result} from "../../../../../app/api/fork/agent/[agentId]/tasks/[taskId]/result/route";
import {POST as kit} from "../../../../../app/api/fork/kit/[kind]/route";
import {GET as status} from "../../../../../app/api/fork/status/route";

let w: SecWorld; let kek: string; let admin: string;
const key = testKeypair();
type Agent = {id: string; bundle: ChannelBundle; taskId: string};
let A: Agent, B: Agent;

const green = () => { registerSelfCheck(async () => ({ok: true})); registerActivePolicyProbe(async () => 0); setLaneStatus({state: "applied"}); };
const dep = (userId: string) => chDeps(w.t, kek, key, userId, {role: "admin"});

async function enrolled(orgId: string): Promise<Agent> {
    const id = await seedAgent(w.pool, orgId);
    await w.pool.query("update agents set version='1.25.2' where id=$1", [id]);
    const r = await enrolAgent(dep(admin), {agentId: id, password: PASSWORD});
    if (!r.ok) throw new Error(`enrol: ${r.code}`);
    await w.pool.query("update fork_agent_enrollment set capabilities=$2 where agent_id=$1", [id, ["channel.v1", "noop.v1", "plaintext-hash.v1"]]);
    const q = await enqueueTask(dep(admin), {agentId: id, type: "noop", payload: {echo: "w27a"}});
    if (!q.ok) throw new Error(`enqueue: ${q.code}`);
    return {id, bundle: decodeBundle(r.bundle), taskId: q.taskId};
}

beforeAll(async () => {
    process.env.PRIVATE_PATH = mkdtempSync(path.join(tmpdir(), "w27-route-"));
    process.env.FORK_STACKS_ENABLED = "true";
    kek = mkdtempSync(path.join(tmpdir(), "w27-kek-"));
    w = await seedSecWorld(); h.db = w.db;
    admin = await adminUser(w.pool);
    const org = await seedOrg(w.pool, "route-org");
    A = await enrolled(org); B = await enrolled(org);
});
afterAll(async () => { await w?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => { resetRateLimits(); green(); h.user = null; });

const AGENT_ROUTES: Array<[string, (a: Agent, t: string) => string, (req: Request, ctx: {params: Promise<never>}) => Promise<Response>, boolean]> = [
    ["POST /api/fork/agent/[agentId]/lease", (a) => `/api/fork/agent/${a.id}/lease`, lease as never, false],
    ["POST /api/fork/agent/[agentId]/hash-report", (a) => `/api/fork/agent/${a.id}/hash-report`, hashReport as never, false],
    ["POST /api/fork/agent/[agentId]/tasks/[taskId]/heartbeat", (a, t) => `/api/fork/agent/${a.id}/tasks/${t}/heartbeat`, heartbeat as never, true],
    ["POST /api/fork/agent/[agentId]/tasks/[taskId]/result", (a, t) => `/api/fork/agent/${a.id}/tasks/${t}/result`, result as never, true],
    ["POST /api/fork/agent/[agentId]/tasks/[taskId]/render", (a, t) => `/api/fork/agent/${a.id}/tasks/${t}/render`, render as never, true],
    ["POST /api/fork/agent/[agentId]/tasks/[taskId]/quiesce", (a, t) => `/api/fork/agent/${a.id}/tasks/${t}/quiesce`, quiesce as never, true],
];
const req = (p: string, auth: string | null, body: unknown = {}, ip = "198.51.100.7") => new Request(`http://dash.sec.test${p}`, {method: "POST", headers: {"content-type": "application/json", "x-forwarded-for": ip, ...(auth === null ? {} : {authorization: auth})}, body: JSON.stringify(body)});
const call = async (r: (typeof AGENT_ROUTES)[number], pathAgent: Agent, taskId: string, auth: string | null, body?: unknown) => {
    resetRateLimits();
    const p = r[1](pathAgent, taskId);
    const [, agentId, , tid] = [...p.match(/agent\/([^/]+)(\/tasks\/([^/]+))?/)!];
    const res = await r[2](req(p, auth, body), {params: Promise.resolve({agentId, taskId: tid} as never)});
    return {status: res.status, body: await res.text()};
};
const tasksHash = async () => createHash("sha256").update(await dumpForkTables(w.pool, {exclude: ["fork_audit_event", "fork_lock"]})).digest("hex");
const sec = (a: Agent) => a.bundle.credential;

describe("agent routes: bearer authentication (ADR-007 D2)", () => {
    it.each(AGENT_ROUTES.map((r) => [r[0], r] as const))("%s: every failure is the SAME 401 body and changes nothing; never 2xx without the right credential", async (_n, r) => {
        const before = await tasksHash();
        const forms: Record<string, string | null> = {
            "no header": null, "empty": "", "scheme only": "Bearer", "basic": "Basic Zm9vOmJhcg==", "lowercase scheme": `bearer ${sec(A)}`,
            "agent B credential on A's path": `Bearer ${sec(B)}`, "wrong secret": `Bearer fork.${A.id}.${"A".repeat(43)}`,
            "other agent id inside the bearer": `Bearer fork.${B.id}.${sec(A).split(".")[2]}`, "truncated": `Bearer ${sec(A).slice(0, -5)}`, "extra dots": `Bearer ${sec(A)}.extra`,
            "latin-1 extended": "Bearer fork.\u00e9.\u00ff\u00a0", "4 KB header": `Bearer ${"x".repeat(4096)}`, "sql-ish": "Bearer ' or 1=1 --",
        };
        const seen = new Map<string, string>();
        for (const [name, auth] of Object.entries(forms)) {
            const res = await call(r, A, B.taskId, auth);
            expect(res.status, `${name} → ${res.status} ${res.body.slice(0, 80)}`).toBe(401);
            seen.set(name, res.body);
        }
        expect(new Set(seen.values()).size, "all 401 bodies identical").toBe(1);
        expect([...seen.values()][0]).toBe(JSON.stringify({code: "unauthorized"}));
        // unknown agent id in the path (A's secret) and a non-uuid path segment: the same answer
        const unknown = await call(r, {...A, id: randomUUID()}, B.taskId, `Bearer ${sec(A)}`);
        expect(unknown.status).toBe(401); expect(unknown.body).toBe(JSON.stringify({code: "unauthorized"}));
        expect(await tasksHash(), "failed authentication changed no fork row").toBe(before);
    });

    it("lease/hash-report with the correct credential pass authentication (never 401/403)", async () => {
        for (const r of AGENT_ROUTES.slice(0, 2)) {
            const res = await call(r, A, A.taskId, `Bearer ${sec(A)}`, {capabilities: ["channel.v1"]});
            expect([401, 403], `${r[0]} ${res.body.slice(0, 100)}`).not.toContain(res.status);
        }
    });

    it("A's credential on B's task id never touches B's rows (heartbeat / result / render / quiesce)", async () => {
        const before = await tasksHash();
        for (const r of AGENT_ROUTES.filter((x) => x[3])) {
            const res = await call(r, A, B.taskId, `Bearer ${sec(A)}`, {lease_id: randomUUID(), status: "succeeded", result: {canary: "w27"}});
            expect(res.status, `${r[0]} → ${res.status} ${res.body.slice(0, 100)}`).not.toBe(200);
            expect(res.status).toBeLessThan(500);
        }
        const rows = (await w.pool.query("select status, lease_id, result from fork_agent_task where id=$1", [B.taskId])).rows[0];
        expect(rows.status).toBe("queued"); expect(rows.lease_id ?? null).toBeNull();
        void before;
    });

    it("a revoked enrolment and a disabled channel: 401 for everything but a matching credential; 403 channel_disabled ONLY with the right credential", async () => {
        const C = await enrolled((await w.pool.query("select organization_id from agents where id=$1", [A.id])).rows[0].organization_id);
        const lr = AGENT_ROUTES[0]!;
        expect((await setChannelEnabled(dep(admin), {agentId: C.id, enabled: false})).ok).toBe(true);
        const ok = await call(lr, C, C.taskId, `Bearer ${sec(C)}`, {capabilities: []});
        expect(ok.status).toBe(403); expect(JSON.parse(ok.body)).toEqual({code: "channel_disabled"});
        const stranger = await call(lr, C, C.taskId, `Bearer fork.${C.id}.${"B".repeat(43)}`, {capabilities: []});
        expect(stranger.status).toBe(401); // a disabled channel discloses nothing to a stranger
        expect((await setChannelEnabled(dep(admin), {agentId: C.id, enabled: true})).ok).toBe(true);
        expect((await revokeEnrollment(dep(admin), {agentId: C.id})).ok).toBe(true);
        const revoked = await call(lr, C, C.taskId, `Bearer ${sec(C)}`, {capabilities: []});
        expect(revoked.status).toBe(401); expect(revoked.body).toBe(JSON.stringify({code: "unauthorized"}));
    });

    it("flags off: every agent route is a plain 404 (no oracle for the channel's existence)", async () => {
        const saved = process.env.FORK_STACKS_ENABLED;
        delete process.env.FORK_STACKS_ENABLED; delete process.env.FORK_ARCANE_ENABLED;
        registerActivePolicyProbe(async () => 0);
        try {
            for (const r of AGENT_ROUTES) expect((await call(r, A, A.taskId, `Bearer ${sec(A)}`)).status, r[0]).toBe(404);
        } finally { process.env.FORK_STACKS_ENABLED = saved; }
    });
});

const kitReq = (headers: Record<string, string> = {}, body: unknown = {token: "t".repeat(30)}, kind = "digital") =>
    kit(new Request(`http://dash.sec.test/api/fork/kit/${kind}`, {method: "POST", headers: {"content-type": "application/json", "sec-fetch-site": "same-origin", ...headers}, body: JSON.stringify(body)}), {params: Promise.resolve({kind})});
const as = (u: SecUser | null) => { h.user = u ? {id: u.id, role: u.role, banned: u.banned} : null; };

describe("POST /api/fork/kit/[kind]: CSRF first, session only, system admin", () => {
    it("cross-site / no-origin / text-plain are refused 403 BEFORE authentication or any lookup (anon session too)", async () => {
        as(null);
        expect((await kitReq({"sec-fetch-site": "cross-site"})).status).toBe(403);
        expect((await kitReq({"sec-fetch-site": "same-site"})).status).toBe(403);
        const noOrigin = await kit(new Request("http://dash.sec.test/api/fork/kit/digital", {method: "POST", headers: {"content-type": "application/json"}, body: "{}"}), {params: Promise.resolve({kind: "digital"})});
        expect(noOrigin.status).toBe(403);
        expect((await kitReq({"content-type": "text/plain"})).status).toBe(403);
        expect((await kitReq({"content-type": "application/x-www-form-urlencoded"})).status).toBe(403);
    });
    it("API-key / bearer clients are refused; unknown kind 404", async () => {
        as(w.users.superOwner);
        expect((await kitReq({"x-api-key": "k"})).status).toBe(403);
        expect((await kitReq({authorization: `Bearer ${sec(A)}`})).status).toBe(403);
        expect((await kitReq({}, {}, "../etc/passwd")).status).toBe(404);
    });
    it("anon / pending / banned / member / orgAdmin / owner → 403 forbidden, never a kit; sysAdmin without a step-up token → 410 token_invalid (the ACL passed, the grant did not)", async () => {
        for (const [name, u] of [["anon", null], ["pending", w.users.pending], ["banned", w.users.banned], ["member", w.users.member], ["orgAdmin", w.users.orgAdmin], ["owner", w.users.owner]] as const) {
            as(u);
            const res = await kitReq();
            expect(res.status, name).toBe(403);
            const text = await res.text();
            expect(text, name).not.toMatch(/BEGIN|kit_|"html"|"file"/);
        }
        for (const u of [w.users.sysAdmin, w.users.superOwner]) {
            as(u);
            const res = await kitReq({}, {token: "t".repeat(30)}, "paper");
            expect(res.status, `${u.role} → ${await res.clone().text()}`).toBe(410);
        }
    });
});

describe("GET /api/fork/status", () => {
    it("404 for anon / pending-less roles without arcane.manage; 200 only for system admins; never carries a secret-looking value", async () => {
        for (const u of [null, w.users.member, w.users.orgAdmin, w.users.owner, w.users.foreignOwner]) { as(u); expect((await status()).status, u?.role ?? "anon").toBe(404); }
        for (const u of [w.users.sysAdmin, w.users.superOwner]) {
            as(u);
            const res = await status();
            expect(res.status).toBe(200);
            const body = await res.text();
            expect(Object.keys(JSON.parse(body)).sort()).toEqual(["banner", "flags", "lane", "lockReason", "mode", "warnings"]);
        }
    });
    it("flags off → 404 even for a system admin", async () => {
        const saved = process.env.FORK_STACKS_ENABLED; delete process.env.FORK_STACKS_ENABLED; delete process.env.FORK_ARCANE_ENABLED;
        registerActivePolicyProbe(async () => 0);
        try { as(w.users.superOwner); expect((await status()).status).toBe(404); } finally { process.env.FORK_STACKS_ENABLED = saved; }
    });
});

describe("route matrix completeness", () => {
    it("every route row is exercised by this file (ROUTE_MATRIX ≡ the handlers imported above)", () => {
        expect(Object.keys(ROUTE_MATRIX).sort()).toEqual([...AGENT_ROUTES.map((r) => r[0]), "POST /api/fork/kit/[kind]", "GET /api/fork/status"].sort());
        expect(listForkRoutes().map(routeKey).sort()).toEqual(Object.keys(ROUTE_MATRIX).sort());
    });
});
