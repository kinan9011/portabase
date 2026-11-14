import {randomUUID, createHash} from "node:crypto";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {registerActivePolicyProbe, registerSelfCheck, setLaneStatus} from "@/fork/mode";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {dumpForkTables} from "../../security/canary";
import {ACTION_MATRIX, type ActionRow} from "../../security/matrix";
import {IDOR, ROLES, type Role} from "../../security/roles";
import {cloneWorld, type SecUser, type SecWorld, sealTemplate, seedSecWorld} from "../../security/world";

/**
 * SEC-09 behavioural permission matrix (plan D-2..D-6): every fork server action × the 8 principals × the 2 IDOR columns × the D21 locked column, through the REAL
 * exported action (next-safe-action + userAction + getForkPrincipal + service). Only the session (`currentUser`) and the app DB handle are replaced.
 * The oracle (`allow`) is hand-written in security/matrix.ts. A mismatch is a FINDING — never weaken a row to make it pass.
 */
const h = vi.hoisted(() => ({user: null as null | Record<string, unknown>, db: null as unknown, caps: [] as string[]}));
vi.mock("@/utils/get-server-url", () => ({getServerUrl: () => "https://dash.sec.test"}));
vi.mock("@/lib/auth/current-user", () => ({currentUser: async () => h.user}));
vi.mock("@/fork/db/handle", async (orig) => ({...(await orig<typeof import("@/fork/db/handle")>()), appDb: async () => h.db}));
vi.mock("@/fork/acl", async (orig) => {
    const a = await orig<typeof import("@/fork/acl")>();
    return {...a, forkCan: (actor: never, cap: string) => { h.caps.push(cap); return a.forkCan(actor, cap); }, assertForkCapability: (p: never, o: string, cap: string) => { h.caps.push(cap); return a.assertForkCapability(p, o, cap); }};
});
vi.mock("@/fork/resource-scope", async (orig) => {
    const a = await orig<typeof import("@/fork/resource-scope")>();
    return {...a, assertForkResource: (db: never, p: never, cap: string, ref: never) => { h.caps.push(cap); return a.assertForkResource(db, p, cap, ref); }};
});

let tpl: SecWorld;
const LOAD: Record<string, () => Promise<unknown>> = {
    "agent-channel.action.ts": () => import("@/fork/actions/agent-channel.action"),
    "arcane-connection.action.ts": () => import("@/fork/actions/arcane-connection.action"),
    "arcane-environment.action.ts": () => import("@/fork/actions/arcane-environment.action"),
    "dashboard-db.action.ts": () => import("@/fork/actions/dashboard-db.action"),
    "kit.action.ts": () => import("@/fork/actions/kit.action"),
    "mirror.action.ts": () => import("@/fork/actions/mirror.action"),
    "materialize.action.ts": () => import("@/fork/actions/materialize.action"),
    "restore-plan.action.ts": () => import("@/fork/actions/restore-plan.action"),
    "restore-run.action.ts": () => import("@/fork/actions/restore-run.action"),
    "runner.action.ts": () => import("@/fork/actions/runner.action"),
    "stack-config.action.ts": () => import("@/fork/actions/stack-config.action"),
    "stack-policy.action.ts": () => import("@/fork/actions/stack-policy.action"),
    "stack-quiesce.action.ts": () => import("@/fork/actions/stack-quiesce.action"),
    "stack-run.action.ts": () => import("@/fork/actions/stack-run.action"),
    "stack-schedule.action.ts": () => import("@/fork/actions/stack-schedule.action"),
    "sync.action.ts": () => import("@/fork/actions/sync.action"),
    "test-restore.action.ts": () => import("@/fork/actions/test-restore.action"),
};
const mods: Record<string, Record<string, (i: unknown) => Promise<{data?: unknown; serverError?: string; validationErrors?: unknown}>>> = {};

beforeAll(async () => {
    process.env.PRIVATE_PATH = await mkdtemp(path.join(os.tmpdir(), "w27-sec-"));
    process.env.FORK_STACKS_ENABLED = "true";
    process.env.FORK_ARCANE_ENABLED = "true";
    process.env.FORK_ARCANE_NET_ALLOWLIST = "127.0.0.1";
    for (const [f, load] of Object.entries(LOAD)) mods[f] = (await load()) as never;
    tpl = await seedSecWorld();
    await sealTemplate(tpl);
});
afterAll(async () => {
    const a = new (await import("pg")).Pool({connectionString: process.env.FORK_TEST_DATABASE_URL, max: 1});
    if (tpl) await a.query(`drop database if exists ${tpl.name} with (force)`);
    await a.end();
    delete process.env.PRIVATE_PATH;
});

const setCaller = (u: SecUser | null) => { h.user = u ? {id: u.id, role: u.role, banned: u.banned} : null; };
const green = () => { registerSelfCheck(async () => ({ok: true})); registerActivePolicyProbe(async () => 0); setLaneStatus({state: "applied"}); };
const red = () => { registerSelfCheck(async () => ({ok: false, failed: "w27-matrix"})); registerActivePolicyProbe(async () => 1); setLaneStatus({state: "applied"}); };

type Seen = {kind: "denied" | "refused-locked" | "passed" | "crash" | "session"; code?: string; raw: string};
async function call(key: string, row: ActionRow, w: SecWorld, user: SecUser | null, id: string): Promise<Seen> {
    const [file, exp] = key.split("#") as [string, string];
    h.db = w.db; setCaller(user); h.caps.length = 0; resetRateLimits();
    let r: {data?: unknown; serverError?: string};
    try { r = await mods[file]![exp]!(row.input(w, id)); } catch (e) { return {kind: "crash", raw: String(e)}; }
    const raw = JSON.stringify(r);
    if (r.serverError !== undefined) return {kind: user === null || user.banned || user.role === "pending" ? "session" : "crash", raw};
    const code = (r.data as {code?: string} | undefined)?.code;
    if (code === "forbidden" || code === "not_found") return {kind: "denied", code, raw};
    if (code === "locked") return {kind: "refused-locked", code, raw};
    return {kind: "passed", code, raw};
}
const hashWorld = async (w: SecWorld) => createHash("sha256").update(await dumpForkTables(w.pool, {exclude: ["fork_audit_event", "fork_lock"]})).digest("hex");
const noIds = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");

describe.each(Object.entries(ACTION_MATRIX))("%s", (key, row) => {
    it("role × action: allow-list is the oracle; denied calls are side-effect free; capability is the declared one; D21 locked column", async () => {
        const problems: string[] = [];
        const callerOf = (role: Role, w: SecWorld) => (role === "anon" ? null : w.users[role]);
        const rid = (w: SecWorld) => w.ids[row.idKey];

        // ---- denied principals share ONE world: any state change shows in the hash
        const dw = await cloneWorld(tpl);
        try {
            green();
            const before = await hashWorld(dw);
            for (const role of ROLES.filter((r) => !row.allow.includes(r))) {
                const s = await call(key, row, dw, callerOf(role, dw), rid(dw));
                if (s.kind !== "denied" && s.kind !== "session") problems.push(`${role}: expected denied, got ${s.kind}${s.code ? `:${s.code}` : ""} ${s.raw.slice(0, 160)}`);
            }
            if (row.resource !== "system") {
                const fo = await call(key, row, dw, dw.users.foreignOwner, rid(dw));
                const miss = await call(key, row, dw, dw.users.superOwner, randomUUID());
                if (fo.kind !== "denied" || fo.code !== "not_found") problems.push(`foreignOwner: expected not_found, got ${fo.kind}:${fo.code} ${fo.raw.slice(0, 160)}`);
                if (miss.kind !== "denied" || miss.code !== "not_found") problems.push(`missingId: expected not_found, got ${miss.kind}:${miss.code} ${miss.raw.slice(0, 160)}`);
                if (fo.kind === "denied" && miss.kind === "denied" && noIds(fo.raw) !== noIds(miss.raw)) problems.push(`existence oracle: foreign vs missing refusal differ (${noIds(fo.raw).slice(0, 100)} | ${noIds(miss.raw).slice(0, 100)})`);
            }
            if ((await hashWorld(dw)) !== before) problems.push("a DENIED call changed fork state (side effect)");
        } finally { await dw.drop(); }

        // ---- allowed principals: fresh world each (they mutate); capability recording on superOwner
        for (const role of row.allow) {
            const aw = await cloneWorld(tpl);
            try {
                green();
                const s = await call(key, row, aw, callerOf(role, aw), rid(aw));
                if (s.kind !== "passed") problems.push(`${role}: expected the ACL gate to pass, got ${s.kind}${s.code ? `:${s.code}` : ""} ${s.raw.slice(0, 200)}`);
                if (role === "superOwner" && !h.caps.includes(row.capability)) problems.push(`declared capability ${row.capability} was never checked (saw: ${[...new Set(h.caps)].join(",") || "none"})`);
            } finally { await aw.drop(); }
        }

        // ---- D21 locked column (superOwner, self-check red + an activated policy)
        const lw = await cloneWorld(tpl);
        try {
            red();
            const s = await call(key, row, lw, lw.users.superOwner, rid(lw));
            if (row.whileLocked === "refused" && s.kind !== "refused-locked") problems.push(`locked: expected code locked, got ${s.kind}${s.code ? `:${s.code}` : ""} ${s.raw.slice(0, 160)}`);
            if (row.whileLocked === "allowed" && s.kind === "refused-locked") problems.push(`locked: row says allowed while locked (${row.lockedWhy}) but got locked`);
        } finally { green(); await lw.drop(); }

        expect(problems, `${key}\n  ${problems.join("\n  ")}`).toEqual([]);
    }, 120_000);
});

void IDOR;
