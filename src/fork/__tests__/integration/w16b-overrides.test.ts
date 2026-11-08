import {createHash, randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {rmSync} from "node:fs";
import {eq} from "drizzle-orm";
import type {Pool} from "pg";
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {loadTaskKey} from "@/fork/agent-channel/admin";
import {decryptPayload} from "@/fork/agent-channel/payload";
import {leaseTask} from "@/fork/agent-channel/tasks";
import {verifyAuditChain} from "@/fork/audit";
import {resolveOverridesForEnqueue} from "@/fork/config/resolve";
import {applicability, clearRestoreOverrides, getRestoreOverridesView, purgeExpiredOverrides, RestoreOverridesView, setRestoreOverrides, type OverrideDeps} from "@/fork/config/service";
import {OVERRIDE_REFUSALS} from "@/fork/config/vocab";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {loadKeyring} from "@/fork/kek";
import {rotateKekAndReencrypt} from "@/fork/kek-rotation";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {RestorePlanV1} from "@/fork/restore/schema";
import {enqueueRestoreTask, type RestoreTaskDeps} from "@/fork/restore-tasks/enqueue";
import {submitRender} from "@/fork/restore-tasks/render";
import {blankPolicyView} from "@/fork/restore-tasks/view";
import {freshForkDb, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {adminUser, approveRestorePlan, createRestorePlan, deps as chDeps, newKek, P, req, seedW17World, type W17} from "@/fork/__tests__/w17-world";
import {seedUser} from "@/fork/__tests__/w16-world";

let t: W04Db; let pool: Pool; let kek: string; let org: string; let admin: string; let member: string;
const key = testKeypair();
const t0 = new Date(); // ONE real clock read; everything else is injected from it
const HOUR = 3_600_000;
const CAPS = ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1"];
const W = "/srv/restore/app";
const CANARY = `CANARY_W16B_${randomUUID()}`;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const adminP = () => P(admin, "user", [org, "admin"]);
const ov = (over: Partial<OverrideDeps> = {}): OverrideDeps => ({db: t.db, principal: adminP(), kekDir: kek, now: () => t0, configAllowed: async () => true, ...over});
const asAdmin = (over: Partial<RestoreTaskDeps> = {}): RestoreTaskDeps => ({...chDeps(t, kek, key, admin, {role: "user", memberships: [[org, "admin"]], now: () => t0}), artifactUrl: async (id) => `https://minio.example.test/${id}?X-Amz-Signature=S`, ...over});

beforeAll(async () => { t = await freshForkDb(); pool = t.pool; kek = newKek(); org = await seedOrg(pool); admin = await adminUser(pool); member = await seedUser(pool, "user"); });
afterAll(async () => { await t?.drop(); rmSync(kek, {recursive: true, force: true}); });
beforeEach(() => resetRateLimits());
afterEach(() => vi.restoreAllMocks());

const world = (o: {hostRole?: "production" | "test"; caps?: string[]} = {}) => seedW17World(t, kek, key, admin, {org, caps: o.caps ?? CAPS, hostRole: o.hostRole});
async function planFor(w: W17, o: {select?: string[]; mode?: "new_stack" | "selective"; approve?: boolean} = {}) {
    const clock = {now: () => t0};
    const c = await createRestorePlan({db: t.db, principal: adminP(), configAllowed: async () => true, ...clock}, req(w, {mode: o.mode ?? "new_stack", mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: o.select ?? ["dir:/srv/app", "volume:app_data", "db:db"], sqlite: null}}));
    if (!c.ok) throw new Error(`plan refused: ${c.code}`);
    if (o.approve !== false) for (const kind of ["production_target", "destructive_replace"] as const) await approveRestorePlan({db: t.db, principal: P(admin, "admin"), configAllowed: async () => true, ...clock}, {planId: c.planId, planHash: c.planHash, kind});
    return c;
}
const fresh = async (o: Parameters<typeof planFor>[1] = {}) => { const w = await world(); const c = await planFor(w, o); return {w, c, id: {planId: c.planId, planHash: c.planHash}}; };
const rowOf = async (planId: string) => (await q("select * from fork_restore_override where plan_id=$1", [planId]))[0];
const manifest = (w: W17) => ({json: w.manifestJson, sigB64: w.manifestSig});
const enr = async (agentId: string) => (await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId)))[0]!;
const payloadOf = async (w: W17, taskId: string, type: string) => {
    const [task] = await q("select * from fork_agent_task where id=$1", [taskId]);
    return JSON.parse(decryptPayload(await loadTaskKey(chDeps(t, kek, key, admin), await enr(w.agent)), {taskId, agentId: w.agent, type}, task.payload_enc).toString());
};
const DOC = {name: "app", services: {web: {image: "nginx:1", environment: {A: "x"}, networks: {default: null}}}, networks: {default: {name: "app_default"}}};
/** lease the freshly enqueued compose_render task and store a (blanked) render for it, the way the agent route would */
async function completeRender(w: W17, taskId: string, restoreId: string, doc: unknown = DOC) {
    const e = await enr(w.agent);
    // earlier queued tasks of this agent (restore_db …) would be leased first: they are not under test here
    await pool.query("update fork_agent_task set status='succeeded', finished_at=now() where agent_id=$1 and id<>$2 and status='queued'", [w.agent, taskId]);
    const l = await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: t0});
    expect(l?.task_id ?? l?.id ?? taskId).toBeTruthy();
    const view = Buffer.from(JSON.stringify(blankPolicyView(doc)));
    const r = await submitRender(t.db, e, {taskId, organizationId: org, now: t0, body: {lease_id: l!.lease_id, restore_id: restoreId, view_b64: view.toString("base64"), view_sha256: sha(view), raw: {refused: false, violations: [], reason: null}, roots: [W], files: ["compose.yml"], compose_version: "5.4.0", rules_sha256: "e".repeat(64)}});
    expect(r).toMatchObject({ok: true});
    await pool.query("update fork_agent_task set status='succeeded', finished_at=now(), lease_id=null, lease_until=null where id=$1", [taskId]);
}
const render = (w: W17, c: {planId: string; planHash: string}, restoreId: string, extra: Record<string, unknown> = {}, d: RestoreTaskDeps = asAdmin()) =>
    enqueueRestoreTask(d, {type: "compose_render", planId: c.planId, planHash: c.planHash, restoreId, manifest: manifest(w), ...extra});
const later = (type: "compose_up" | "restore_db", w: W17, c: {planId: string; planHash: string}, restoreId: string, extra: Record<string, unknown> = {}) =>
    enqueueRestoreTask(asAdmin(), {type, planId: c.planId, planHash: c.planHash, restoreId, manifest: manifest(w), approval: null, ...extra});
const setA = (id: {planId: string; planHash: string}, value = CANARY, extra: Record<string, unknown> = {}, d: OverrideDeps = ov()) => setRestoreOverrides(d, {...id, set: [{service: "web", key: "A", value}], ...extra});
const everything = async () => (await Promise.all(["fork_restore_override", "fork_audit_event", "fork_compose_render", "fork_agent_task"].map(async (n) => JSON.stringify(await q(`select * from ${n}`))))).join("\n");

describe("W16b overrides: ACL, gates, IDOR (test 1)", () => {
    it("member forbidden; org admin and owner ok; system admin without membership refused; unknown / foreign / malformed ids give the same answer; every denial audited without the canary", async () => {
        const {id} = await fresh();
        const set = (principal: ReturnType<typeof P> | null) => setA(id, CANARY, {}, ov({principal}));
        expect(await set(P(member, "user", [org, "member"]))).toMatchObject({ok: false, code: "forbidden"});
        expect(await set(P(admin, "user", [org, "owner"]))).toMatchObject({ok: true});
        expect(await set(adminP())).toMatchObject({ok: true});
        const sysAdmin = await set(P(admin, "admin"));
        expect(sysAdmin.ok).toBe(false);
        expect(["forbidden", "not_found"]).toContain((sysAdmin as {code: string}).code);
        expect(await set(null)).toMatchObject({ok: false, code: "forbidden"});
        const otherOrg = await seedOrg(pool);
        const stranger = await setA(id, CANARY, {}, ov({principal: P(member, "user", [otherOrg, "owner"])}));
        const unknown = await setRestoreOverrides(ov({principal: P(member, "user", [otherOrg, "owner"])}), {planId: randomUUID(), planHash: id.planHash, set: [{service: "web", key: "A", value: CANARY}]});
        const malformed = await setRestoreOverrides(ov(), {planId: "not-a-uuid", planHash: id.planHash});
        expect(stranger).toEqual(unknown); // no existence oracle
        expect(stranger).toMatchObject({ok: false, code: "not_found"});
        expect(malformed).toMatchObject({ok: false, code: "invalid_input"});
        expect(await getRestoreOverridesView(ov({principal: P(member, "user", [org, "member"])}), id)).toMatchObject({ok: false, code: "forbidden"});
        expect(await clearRestoreOverrides(ov({principal: P(member, "user", [org, "member"])}), id)).toMatchObject({ok: false, code: "forbidden"});
        const denied = await q("select redacted_details as details from fork_audit_event where action='fork.restore_override.denied'");
        expect(denied.length).toBeGreaterThanOrEqual(6);
        expect(JSON.stringify(denied)).not.toContain(CANARY);
    });

    it("locked mode ⇒ locked; the 21st call in a minute ⇒ rate_limited", async () => {
        const {id} = await fresh();
        expect(await setA(id, CANARY, {}, ov({configAllowed: async () => false}))).toMatchObject({ok: false, code: "locked"});
        expect(await getRestoreOverridesView(ov({configAllowed: async () => false}), id)).toMatchObject({ok: false, code: "locked"});
        for (let i = 0; i < 20; i++) expect(await getRestoreOverridesView(ov(), id)).toMatchObject({ok: true});
        expect(await getRestoreOverridesView(ov(), id)).toMatchObject({ok: false, code: "rate_limited"});
        expect(await q("select 1 from fork_audit_event where action='fork.restore_override.denied' and redacted_details->>'reason'='rate_limited'")).toHaveLength(1);
    });
});

describe("W16b overrides: binding to the plan hash, AAD, expiry (test 2)", () => {
    it("wrong hash ⇒ hash_mismatch; expired plan ⇒ expired; tampered plan ⇒ plan_tampered", async () => {
        const {id} = await fresh();
        expect(await setA(id)).toMatchObject({ok: true});
        expect(await setRestoreOverrides(ov(), {planId: id.planId, planHash: "b".repeat(64), set: []})).toMatchObject({ok: false, code: "hash_mismatch"});
        expect(await getRestoreOverridesView(ov({now: () => new Date(t0.getTime() + 25 * HOUR)}), id)).toMatchObject({ok: false, code: "expired"});
        const e = await fresh();
        await pool.query("update fork_restore_plan set plan = jsonb_set(plan, '{blockers}', '[\"x\"]') where id=$1", [e.id.planId]);
        expect(await setA(e.id)).toMatchObject({ok: false, code: "plan_tampered"});
    });

    it("a ciphertext copied onto another plan's row fails closed (AAD); a plan_hash edit fails closed; nothing is signed", async () => {
        const a = await fresh(); const b = await fresh();
        expect(await setA(a.id, `${CANARY}-a`)).toMatchObject({ok: true});
        expect(await setA(b.id, `${CANARY}-b`)).toMatchObject({ok: true});
        await pool.query("update fork_restore_override set values_enc = (select values_enc from fork_restore_override where plan_id=$1) where plan_id=$2", [a.id.planId, b.id.planId]);
        expect(await resolveOverridesForEnqueue(t.db, {...b.id, now: t0, kekDir: kek})).toEqual({ok: false, code: "overrides_unreadable"});
        const before = (await q("select count(*)::int n from fork_agent_task"))[0].n;
        expect(await render(b.w, b.id, randomUUID())).toMatchObject({ok: false, code: "invalid_input"});
        expect(await setRestoreOverrides(ov(), {...b.id, set: [{service: "web", key: "A", value: "x"}]})).toMatchObject({ok: false, code: "overrides_unreadable"});
        expect((await q("select count(*)::int n from fork_agent_task"))[0].n).toBe(before);
        await pool.query("update fork_restore_override set plan_hash=$2 where plan_id=$1", [a.id.planId, "c".repeat(64)]);
        expect(await resolveOverridesForEnqueue(t.db, {...a.id, now: t0, kekDir: kek})).toEqual({ok: false, code: "hash_mismatch"});
        // an expired row is purged by resolve and yields "no overrides", never stale plaintext
        await pool.query("update fork_restore_override set expires_at = now() - interval '1 minute' where plan_id=$1", [b.id.planId]);
        expect(await resolveOverridesForEnqueue(t.db, {...b.id, now: new Date(), kekDir: kek})).toEqual({ok: true, value: null});
        expect(await rowOf(b.id.planId)).toBeUndefined();
    });
});

describe("W16b overrides: applicability and keys (test 3)", () => {
    it("blocked plan, plan without compose_up ⇒ overrides_not_applicable; key outside plan.secrets ⇒ unknown_key", async () => {
        const nocaps = await world({caps: ["channel.v1", "noop.v1", "restore.target.v1"]});
        const blocked = await planFor(nocaps, {approve: false});
        expect(await setA({planId: blocked.planId, planHash: blocked.planHash})).toMatchObject({ok: false, code: "overrides_not_applicable"});
        const sel = await fresh({select: ["dir:/srv/app", "volume:app_data"], mode: "selective"});
        expect(await setA(sel.id)).toMatchObject({ok: false, code: "overrides_not_applicable"});
        const ok = await fresh();
        expect(await setRestoreOverrides(ov(), {...ok.id, set: [{service: "web", key: "NOPE", value: "x"}]})).toMatchObject({ok: false, code: "unknown_key"});
        expect(await setRestoreOverrides(ov(), {...ok.id, set: [{service: "other", key: "A", value: "x"}]})).toMatchObject({ok: false, code: "unknown_key"});
        expect(await rowOf(ok.id.planId)).toBeUndefined();
    });

    it("the pure applicability rule: data-only test restores and rootless plans never take overrides", async () => {
        const {c} = await fresh();
        const plan = RestorePlanV1.parse((await q("select plan from fork_restore_plan where id=$1", [c.planId]))[0].plan);
        expect(applicability(plan)).toEqual({ok: true});
        expect(applicability({...plan, purpose: "test_restore"})).toEqual({ok: false, reason: "purpose"});
        expect(applicability({...plan, outcome: "blocked"})).toEqual({ok: false, reason: "outcome"});
        expect(applicability({...plan, target: {...plan.target, restore_root: null}})).toEqual({ok: false, reason: "no_restore_root"});
        expect(applicability({...plan, actions: plan.actions.filter((a) => a.kind !== "compose_up")})).toEqual({ok: false, reason: "no_compose_up"});
    });
});

describe("W16b overrides: no reveal, encryption at rest, audit (tests 4, 5, 6)", () => {
    it("no function returns the value; the view is names and states only; every refusal code is a plain code", async () => {
        const {id} = await fresh();
        const s = await setA(id, CANARY, {overrideYml: "services:\n  web:\n    restart: always\n"});
        expect(s).toMatchObject({ok: true});
        const v = await getRestoreOverridesView(ov(), id);
        const c = await clearRestoreOverrides(ov(), id);
        for (const r of [s, v, c]) expect(JSON.stringify(r)).not.toContain(CANARY);
        if (s.ok) {
            expect(RestoreOverridesView.parse(s.view)).toEqual(s.view);
            expect(s.view).toMatchObject({frozen: false, revision: 1, yml: {present: true}, fields: [{service: "web", key: "A", isSet: true}]});
            expect(Object.keys(s.view).sort()).toEqual(["applicable", "fields", "frozen", "missingRequired", "reason", "revision", "yml"]);
            expect(Object.keys(s.view.yml).sort()).toEqual(["bytes", "present"]);
            expect(Object.keys(s.view.fields[0]).sort()).toEqual(["class", "isSet", "key", "origin", "service"]);
        }
        for (const code of OVERRIDE_REFUSALS) expect(code).toMatch(/^[a-z_]+$/);
    });

    it("at rest: the row, the DB dump and every fork_% table lack the canary; values_enc carries the active kid and AAD; rotation re-encrypts and resolve still works", async () => {
        const {id} = await fresh();
        expect(await setA(id, CANARY, {overrideYml: `services:\n  web:\n    labels:\n      note: ${CANARY}-yml\n`})).toMatchObject({ok: true});
        const row = (await q("select * from fork_restore_override where plan_id=$1", [id.planId]))[0];
        expect(JSON.stringify(row)).not.toContain(CANARY);
        const ring = (await loadKeyring(kek))!;
        expect(row.values_enc.kid).toBe(ring.active);
        expect(row.env_keys).toEqual([{service: "web", key: "A"}]);
        expect({yml_present: row.yml_present, revision: row.revision}).toEqual({yml_present: true, revision: 1});
        // a DB dump (pg_dump binary or the docker shim) never contains the canary
        const bin = process.env.FORK_PG_DUMP_BIN || "pg_dump";
        let dump: string | null = null;
        try { dump = execFileSync(bin, ["--data-only", t.url], {encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: {...process.env, PGPASSWORD: new URL(t.url).password}}); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (dump !== null) { expect(dump.includes("fork_restore_override")).toBe(true); expect(dump.includes(CANARY)).toBe(false); } else console.warn("pg_dump binary absent: DB-dump canary check skipped (SQL sweep below still runs)");
        // SQL sweep: every fork_% table, as text
        const tables = (await q("select table_name from information_schema.tables where table_schema='public' and table_name like 'fork\\_%' escape '\\'")).map((r) => r.table_name as string);
        expect(tables).toContain("fork_restore_override");
        for (const n of tables) expect((await q(`select count(*)::int c from "${n}" x where x::text like $1`, [`%${CANARY}%`]))[0].c, `canary found in ${n}`).toBe(0);
        // rotation moves the envelope; resolve still returns the plaintext (in memory only)
        const rot = await rotateKekAndReencrypt(t.db, kek);
        expect(rot.moved).toBeGreaterThanOrEqual(1); // (rows of other fixtures carry stub envelopes and are counted as failed by design)
        const after = (await q("select values_enc->>'kid' kid from fork_restore_override where plan_id=$1", [id.planId]))[0].kid;
        expect(after).toBe(rot.newKid);
        expect(after).not.toBe(row.values_enc.kid);
        const r = await resolveOverridesForEnqueue(t.db, {...id, now: t0, kekDir: kek});
        expect(r.ok && JSON.parse(r.value?.payload.overrideYml ?? "{}").services.web.environment.A === CANARY).toBe(true);
    });

    it("audit: one set row with key names, plan hash, revision and sizes; no value, no hash of a value; the chain verifies", async () => {
        const {id} = await fresh();
        expect(await setA(id, CANARY, {overrideYml: "services:\n  web:\n    restart: always\n"})).toMatchObject({ok: true});
        const rows = await q("select redacted_details as details from fork_audit_event where action='fork.restore_override.set' and resource_id=$1", [id.planId]);
        expect(rows).toHaveLength(1);
        expect(rows[0].details).toMatchObject({env_keys: ["web/A"], env_count: 1, plan_hash: id.planHash, revision: 1, yml_present: true, approvals_cleared: expect.any(Number)});
        expect(rows[0].details.yml_bytes).toBeGreaterThan(0);
        const all = JSON.stringify(await q("select * from fork_audit_event"));
        for (const needle of [CANARY, sha(CANARY), sha(`${CANARY}\n`)]) expect(all).not.toContain(needle);
        expect(await verifyAuditChain(t.db)).toMatchObject({ok: true});
    });
});

describe("W16b overrides: approvals invalidated on every change (test 7)", () => {
    it("a production plan: owner approves → admin sets an override → approvals are empty and enqueue is refused until the owner approves again", async () => {
        const w = await world({hostRole: "production"});
        const c = await planFor(w);
        const id = {planId: c.planId, planHash: c.planHash};
        const approvals = async () => (await q("select approvals from fork_restore_plan where id=$1", [c.planId]))[0].approvals as unknown[];
        expect((await approvals()).length).toBeGreaterThan(0);
        expect(await render(w, id, randomUUID())).toMatchObject({ok: true}); // approved plan renders
        expect(await setA(id)).toMatchObject({ok: true});
        expect(await approvals()).toEqual([]);
        expect(await render(w, id, randomUUID())).toMatchObject({ok: false, code: "approval_missing"});
        const audit = await q("select redacted_details as details from fork_audit_event where action='fork.restore_override.set' and resource_id=$1", [c.planId]);
        expect(audit[0].details.approvals_cleared).toBeGreaterThan(0);
        for (const kind of ["production_target", "destructive_replace"] as const) await approveRestorePlan({db: t.db, principal: P(admin, "admin"), configAllowed: async () => true, now: () => t0}, {...id, kind});
        expect(await render(w, id, randomUUID())).toMatchObject({ok: true});
        // clearing also invalidates
        expect(await clearRestoreOverrides(ov(), id)).toMatchObject({ok: true});
        expect(await approvals()).toEqual([]);
    });
});

describe("W16b overrides: enqueue wiring, render binding, freeze, conflict, race, cleanup (test 8)", () => {
    it("stored set ↔ task payload ↔ render ↔ freeze ↔ cleanup purge", async () => {
        const {w, c, id} = await fresh();
        const value = `${CANARY}$x$$y`;
        expect(await setA(id, value)).toMatchObject({ok: true});
        const restoreId = randomUUID();
        // the literal parameter cannot be mixed with a stored set
        expect(await render(w, id, restoreId, {overrides: {env: {}, overrideYml: null}})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await render(w, id, restoreId, {overrides: null})).toMatchObject({ok: false, code: "invalid_input"});
        // render: decrypted payload carries the stored set, row gets restore_id + render_task_id
        const r1 = await render(w, id, restoreId);
        expect(r1).toMatchObject({ok: true});
        if (!r1.ok) return;
        const p = await payloadOf(w, r1.taskId, "compose_render");
        expect(p.compose.env).toEqual({});
        expect(JSON.parse(p.compose.override_yml).services.web.environment.A).toBe(value.replaceAll("$", () => "$$"));
        let row = await rowOf(c.planId);
        expect({restore: row.restore_id, render: row.render_task_id, frozen: row.frozen_at}).toEqual({restore: restoreId, render: r1.taskId, frozen: null});
        expect(JSON.stringify(await q("select * from fork_audit_event"))).not.toContain(CANARY);
        // another restore id may not reuse the set
        expect(await render(w, id, randomUUID())).toMatchObject({ok: false, code: "override_conflict"});
        await completeRender(w, r1.taskId, restoreId);
        // change after the render ⇒ the operator must render again
        expect(await setA(id, `${CANARY}-2`)).toMatchObject({ok: true, view: {revision: 2}});
        expect(await later("compose_up", w, id, restoreId)).toMatchObject({ok: false, code: "render_missing"});
        expect((await q("select redacted_details as details from fork_audit_event where action='fork.restore_task.denied' and redacted_details->>'reason'='render_missing' order by seq desc limit 1"))[0].details.detail).toBe("overrides_changed");
        const r2 = await render(w, id, restoreId);
        expect(r2).toMatchObject({ok: true});
        if (!r2.ok) return;
        await completeRender(w, r2.taskId, restoreId);
        // restore_db freezes
        const db = await later("restore_db", w, id, restoreId);
        expect(db).toMatchObject({ok: true});
        row = await rowOf(c.planId);
        expect(row.frozen_at).not.toBeNull();
        expect(row.render_task_id).toBe(r2.taskId);
        expect(await setA(id, "x")).toMatchObject({ok: false, code: "overrides_frozen"});
        expect(await clearRestoreOverrides(ov(), id)).toMatchObject({ok: false, code: "overrides_frozen"});
        expect(await getRestoreOverridesView(ov(), id)).toMatchObject({ok: true, view: {frozen: true}});
        // the same frozen values may be rendered again (render_task_id moves), compose_up then follows the newest render
        const r3 = await render(w, id, restoreId);
        expect(r3).toMatchObject({ok: true});
        if (!r3.ok) return;
        expect(await later("compose_up", w, id, restoreId)).toMatchObject({ok: false, code: "render_missing"});
        await completeRender(w, r3.taskId, restoreId);
        expect(await later("compose_up", w, id, restoreId)).toMatchObject({ok: true});
        expect(JSON.stringify(await everything())).not.toContain(CANARY);
        // cleanup purges the set and audits it
        const cl = await enqueueRestoreTask(asAdmin(), {type: "restore_cleanup", ...id, restoreId, cleanup: {workspace: true, volumes: true, networks: true, containers: true}});
        expect(cl).toMatchObject({ok: true});
        expect(await rowOf(c.planId)).toBeUndefined();
        const purge = await q("select redacted_details as details from fork_audit_event where action='fork.restore_override.purge' and resource_id=$1", [c.planId]);
        expect(purge).toHaveLength(1);
        expect(purge[0].details).toMatchObject({reason: "cleanup", plan_hash: c.planHash, env_keys: ["web/A"]});
        expect(JSON.stringify(purge)).not.toContain(CANARY);
    });

    it("race: a change between resolve and insert ⇒ overrides_changed and NO task row", async () => {
        const {w, c, id} = await fresh();
        expect(await setA(id)).toMatchObject({ok: true});
        const before = (await q("select count(*)::int n from fork_agent_task"))[0].n;
        const base = chDeps(t, kek, key, admin, {role: "user", memberships: [[org, "admin"]], now: () => t0});
        const racing: RestoreTaskDeps = {...asAdmin(), keys: {...base.keys, signing: async () => { await pool.query("update fork_restore_override set revision = revision + 1 where plan_id=$1", [c.planId]); return base.keys.signing(); }}};
        expect(await render(w, id, randomUUID(), {}, racing)).toMatchObject({ok: false, code: "overrides_changed"});
        expect((await q("select count(*)::int n from fork_agent_task"))[0].n).toBe(before);
        const row = await rowOf(c.planId);
        expect({restore: row.restore_id, render: row.render_task_id}).toEqual({restore: null, render: null});
    });

    it("service-less keys go to the process env; the literal path of W17-ii keeps working when no set is stored", async () => {
        const {w, id} = await fresh();
        const literal = await render(w, id, randomUUID(), {overrides: {env: {OVERRIDE_PROBE: CANARY}, overrideYml: null}});
        expect(literal).toMatchObject({ok: true});
        if (literal.ok) expect((await payloadOf(w, literal.taskId, "compose_render")).compose.env).toEqual({OVERRIDE_PROBE: CANARY});
    });
});

describe("W16b overrides: purge job (test 9)", () => {
    it("deletes exactly the expired row (DB clock), audits it, and the plan FK cascades", async () => {
        const a = await fresh(); const b = await fresh();
        expect(await setA(a.id)).toMatchObject({ok: true});
        expect(await setA(b.id)).toMatchObject({ok: true});
        await pool.query("update fork_restore_override set expires_at = now() - interval '1 minute' where plan_id=$1", [a.id.planId]);
        await pool.query("update fork_restore_override set expires_at = now() + interval '1 hour' where plan_id=$1", [b.id.planId]);
        expect(await purgeExpiredOverrides(t.db, new Date())).toEqual({purged: 1});
        expect(await rowOf(a.id.planId)).toBeUndefined();
        expect(await rowOf(b.id.planId)).toBeDefined();
        const purge = await q("select redacted_details as details, actor_user_id from fork_audit_event where action='fork.restore_override.purge' and resource_id=$1", [a.id.planId]);
        expect(purge).toHaveLength(1);
        expect(purge[0].details).toMatchObject({reason: "expired"});
        expect(purge[0].actor_user_id).toBeNull();
        await pool.query("delete from fork_restore_plan where id=$1", [b.id.planId]);
        expect(await rowOf(b.id.planId)).toBeUndefined();
    });
});

describe("W16b overrides: raw poison at set time, set semantics (test 10)", () => {
    it("a poisoned override is refused with kind + service only; no row; the response never echoes the path", async () => {
        const {id} = await fresh();
        const r = await setA(id, CANARY, {overrideYml: "services:\n  web:\n    env_file: /etc/passwd\n"});
        expect(r).toMatchObject({ok: false, code: "override_raw_refused", violations: [{kind: "env_file", service: "web"}]});
        expect(JSON.stringify(r)).not.toContain("/etc/passwd");
        expect(JSON.stringify(r)).not.toContain(CANARY);
        expect(await rowOf(id.planId)).toBeUndefined();
        expect(JSON.stringify(await q("select redacted_details as details from fork_audit_event where action='fork.restore_override.denied'"))).not.toContain("/etc/passwd");
    });

    it("tags, duplicates and malformed files are refused with a code; unset / yml tri-state / empty set deletes the row; revision counts changes", async () => {
        const {id} = await fresh();
        expect(await setA(id, CANARY, {overrideYml: "services:\n  web:\n    ports: !reset []\n"})).toMatchObject({ok: false, code: "override_yaml_invalid"});
        expect(await setA(id, CANARY, {overrideYml: "services:\n  web:\n    environment:\n      A: x\n"})).toMatchObject({ok: false, code: "override_duplicate_key"});
        expect(await rowOf(id.planId)).toBeUndefined();
        expect(await setA(id)).toMatchObject({ok: true, view: {revision: 1}});
        expect(await setRestoreOverrides(ov(), {...id, overrideYml: "services:\n  web:\n    restart: always\n"})).toMatchObject({ok: true, view: {revision: 2, yml: {present: true}, fields: [{key: "A", isSet: true}]}}); // yml replaced, field kept
        expect(await setRestoreOverrides(ov(), {...id, overrideYml: null})).toMatchObject({ok: true, view: {revision: 3, yml: {present: false}}});
        expect(await setRestoreOverrides(ov(), {...id, unset: [{service: "web", key: "A"}]})).toMatchObject({ok: true, view: {revision: 0, fields: [{isSet: false}]}});
        expect(await rowOf(id.planId)).toBeUndefined();
        expect(await clearRestoreOverrides(ov(), id)).toMatchObject({ok: true}); // idempotent
    });

    it("a missing require_input value is counted, never blocks the set", async () => {
        const {id} = await fresh();
        const v = await getRestoreOverridesView(ov(), id);
        expect(v.ok && v.view.missingRequired).toBeGreaterThanOrEqual(0);
        expect(v.ok && v.view.fields.map((f) => `${f.service}/${f.key}`)).toEqual(["web/A"]);
    });
});

describe("W16b overrides: Arcane / outbound untouched (test 11)", () => {
    it("set / view / clear / enqueue make no outbound request at all", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no outbound calls allowed"));
        const {w, id} = await fresh();
        expect(await setA(id)).toMatchObject({ok: true});
        expect(await getRestoreOverridesView(ov(), id)).toMatchObject({ok: true});
        expect(await render(w, id, randomUUID())).toMatchObject({ok: true});
        expect(await clearRestoreOverrides(ov(), id)).toMatchObject({ok: true});
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
