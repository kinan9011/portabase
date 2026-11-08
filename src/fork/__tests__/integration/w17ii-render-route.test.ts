import {createHash, randomUUID} from "node:crypto";
import {readFileSync, rmSync} from "node:fs";
import path from "node:path";
import {eq} from "drizzle-orm";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {insertSignedTask, leaseTask} from "@/fork/agent-channel/tasks";
import {loadTaskKey} from "@/fork/agent-channel/admin";
import {RENDER_MAX_BODY_BYTES} from "@/fork/agent-channel/vocab";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {latestRender, renderVerdict, submitRender} from "@/fork/restore-tasks/render";
import {blankPolicyView} from "@/fork/restore-tasks/view";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {adminUser, deps as chDeps, newKek, seedW17World} from "@/fork/__tests__/w17-world";
import {resetRateLimits} from "@/fork/net/rate-limit";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string;
const key = testKeypair();
const NOW = new Date("2026-11-07T12:00:00Z");
const CAPS = ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"];
const W = "/srv/restore/app";
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const CLEAN_RAW = {refused: false, violations: [], reason: null};

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => resetRateLimits());

const FULL = {name: "w17lab", services: {web: {image: "busybox:1", environment: {OVERRIDE_PROBE: "CANARY2"}, command: ["sh", "-c", "echo hi"]}}};
const body = (leaseId: string, restoreId: string, doc: unknown = blankPolicyView(FULL), o: Record<string, unknown> = {}) => {
    const view = Buffer.from(JSON.stringify(doc));
    return {lease_id: leaseId, restore_id: restoreId, view_b64: view.toString("base64"), view_sha256: sha(view), raw: CLEAN_RAW, roots: [W], files: ["compose.yml"], compose_version: "5.4.0", rules_sha256: "e".repeat(64), ...o};
};

async function leasedRender(type: "compose_render" | "restore_db" = "compose_render") {
    const w = await seedW17World(t, kek, key, admin, {org, caps: CAPS});
    const e = (await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, w.agent)))[0]!;
    const taskKey = await loadTaskKey(chDeps(t, kek, key, admin), e);
    const ins = await t.db.transaction((tx) => insertSignedTask(tx as never, {e, agentName: "x", type, plaintext: Buffer.from("{}"), targetAgentId: w.agent, actorUserId: admin, signing: {privateKeyPem: key.privateKey}, kid: key.kid, taskKey, now: NOW, ttlMs: 600_000}));
    const l = await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: NOW});
    expect(l?.task_id).toBe(ins.taskId);
    return {w, e, taskId: ins.taskId, leaseId: l!.lease_id};
}
const finish = (e: unknown, taskId: string, leaseId: string) => pool.query("update fork_agent_task set status='succeeded', finished_at=now(), lease_id=null, lease_until=null where id=$1", [taskId]);

describe("render route service (E13)", () => {
    it("stores the policy view; audit carries ids/hash/size only; verdict recomputed by the TS engine; latestRender needs a SUCCEEDED task of that agent", async () => {
        const {w, e, taskId, leaseId} = await leasedRender();
        const restoreId = randomUUID();
        const b = body(leaseId, restoreId);
        expect(await submitRender(t.db, e, {taskId, body: b, organizationId: org, now: NOW})).toEqual({ok: true});
        const [row] = await q("select * from fork_compose_render where task_id=$1", [taskId]);
        expect(row.rendered_sha256).toBe(b.view_sha256);
        expect(row.policy_view).not.toContain("CANARY2");
        expect(row.policy_view).not.toContain("echo hi");
        const audit = await q("select redacted_details d from fork_audit_event where action='fork.compose_render.received'");
        expect(audit).toHaveLength(1);
        expect(JSON.stringify(audit[0].d)).not.toMatch(/busybox|CANARY|view_b64/);
        expect(audit[0].d).toMatchObject({taskId, restoreId, sha256: b.view_sha256});
        expect(await latestRender(t.db, {restoreId, agentId: w.agent})).toBeNull(); // task still running
        await finish(e, taskId, leaseId);
        const r = await latestRender(t.db, {restoreId, agentId: w.agent});
        expect(r?.taskId).toBe(taskId);
        expect(await latestRender(t.db, {restoreId, agentId: randomUUID()})).toBeNull();
        const v = renderVerdict(r!, W);
        expect(v.compose_sha256).toBe(b.view_sha256);
        expect(v.verdict).toBe("allow");
        expect(v.roots).toEqual([W]);
    });
    it("idempotent re-post of the same view; a different view for the same task is a conflict", async () => {
        const {e, taskId, leaseId} = await leasedRender();
        const restoreId = randomUUID();
        expect(await submitRender(t.db, e, {taskId, body: body(leaseId, restoreId), organizationId: org, now: NOW})).toEqual({ok: true});
        expect(await submitRender(t.db, e, {taskId, body: body(leaseId, restoreId), organizationId: org, now: NOW})).toEqual({ok: true, duplicate: true});
        const other = body(leaseId, restoreId, blankPolicyView({...FULL, name: "other"}));
        expect(await submitRender(t.db, e, {taskId, body: other, organizationId: org, now: NOW})).toMatchObject({ok: false, status: 409, code: "conflict"});
        expect(await q("select 1 from fork_compose_render where task_id=$1", [taskId])).toHaveLength(1);
    });
    it("refuses: unredacted view (nothing stored), sha mismatch, lease mismatch, wrong task type, unknown / foreign task, unknown key, oversize", async () => {
        const {w, e, taskId, leaseId} = await leasedRender();
        const restoreId = randomUUID();
        const call = (id: string, b: unknown) => submitRender(t.db, e, {taskId: id, body: b, organizationId: org, now: NOW});
        expect(await call(taskId, body(leaseId, restoreId, FULL))).toMatchObject({ok: false, status: 400, code: "unredacted"});
        expect(await q("select 1 from fork_compose_render where task_id=$1", [taskId])).toHaveLength(0);
        expect(await call(taskId, body(leaseId, restoreId, undefined, {view_sha256: "0".repeat(64)}))).toMatchObject({ok: false, status: 400, code: "hash_mismatch"});
        expect(await call(taskId, body(randomUUID(), restoreId))).toMatchObject({ok: false, status: 409, code: "lease_mismatch"});
        expect(await call(taskId, {...body(leaseId, restoreId), extra: 1})).toMatchObject({ok: false, status: 400, code: "invalid_input"});
        expect(await call(taskId, body(leaseId, restoreId, undefined, {raw: {refused: false, violations: [], reason: "nope"}}))).toMatchObject({ok: false, status: 400});
        expect(await call(randomUUID(), body(leaseId, restoreId))).toMatchObject({ok: false, status: 404});
        const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20);
        expect(await call(taskId, {...body(leaseId, restoreId), view_b64: big.toString("base64"), view_sha256: sha(big)})).toMatchObject({ok: false, status: 400});
        // a task of another type (restore_db) never accepts a render
        const db = await leasedRender("restore_db");
        expect(await submitRender(t.db, db.e, {taskId: db.taskId, body: body(db.leaseId, restoreId), organizationId: org, now: NOW})).toMatchObject({ok: false, status: 409, code: "wrong_type"});
        // a task of ANOTHER agent is invisible (404), even with a valid lease id of its own
        expect(await submitRender(t.db, db.e, {taskId, body: body(leaseId, restoreId), organizationId: org, now: NOW})).toMatchObject({ok: false, status: 404});
        expect(w.agent).not.toBe(db.w.agent);
    });
    it("a finished task no longer accepts a first render", async () => {
        const {e, taskId, leaseId} = await leasedRender();
        await finish(e, taskId, leaseId);
        expect(await submitRender(t.db, e, {taskId, body: body(leaseId, randomUUID()), organizationId: org, now: NOW})).toMatchObject({ok: false, status: 409});
    });
});

describe("route file", () => {
    it("is the result route with a larger body bound and the render service (bearer only, no session)", () => {
        const src = readFileSync(path.join(process.cwd(), "app/api/fork/agent/[agentId]/tasks/[taskId]/render/route.ts"), "utf8");
        expect(src).toContain("withAgent");
        expect(src).toContain("readJsonBody(req, {maxBytes: RENDER_MAX_BODY_BYTES})");
        expect(src).toContain("submitRender");
        expect(src).not.toMatch(/cookies\(|getSession|auth\.api/);
        expect(RENDER_MAX_BODY_BYTES).toBe(3 * 1024 * 1024);
    });
});
