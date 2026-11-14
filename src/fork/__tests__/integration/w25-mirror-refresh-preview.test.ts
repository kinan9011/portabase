import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {forkEnv} from "@/fork/env";
import {addEvent} from "@/fork/mirror/events";
import {loadMirrorDetailExtras, loadMirrorRefreshFacts} from "@/fork/mirror/list-view";
import {RefreshPreview} from "@/fork/mirror/refresh-preview";
import {createMirror, previewMirrorRefresh} from "@/fork/mirror/service";
import {neededBytes} from "@/fork/restore-run/derive";
import {planRestore} from "@/fork/restore/plan";
import {loadPlanInput} from "@/fork/restore/load";
import {mirrorWorld, type MirrorWorld} from "@/fork/__tests__/w22a-world";
import {manifestFor, nextRp} from "@/fork/__tests__/w24-world";
import type {W17} from "@/fork/__tests__/w17-world";

/**
 * W25 `previewMirrorRefresh` (plan-W25 §5.2): candidates, selected plan numbers, last reported capacity, refusals, writes nothing, value-free output, app-change signal, detail facts / lastOp.
 * Template: `w24-mirror-refresh.test.ts` (`make()`), same world and scripted runner.
 */
let w: MirrorWorld;
let orgAdmin: ForkPrincipal, member: ForkPrincipal, foreign: ForkPrincipal;
beforeAll(async () => { w = await mirrorWorld(); orgAdmin = await w.user("admin"); member = await w.user("member"); foreign = await w.user("admin", w.otherOrg); });
afterAll(async () => { await w?.close(); });
beforeEach(() => { w.reset(); w.flag.on = true; w.principals.set(orgAdmin.userId, orgAdmin); });

type Ctx = Awaited<ReturnType<typeof make>>;
async function make(o: {personal?: boolean | null} = {}) {
    const stack = await w.world(o.personal === undefined ? false : o.personal);
    if (o.personal !== undefined && o.personal !== false) await w.q("update fork_stack set mirror_opt_in_at=now(), mirror_opt_in_by=$2 where id=$1", [stack.stack, w.adminId]);
    await w.setSeq(stack);
    const ru = await w.runner();
    const worlds: W17[] = [stack];
    const d = w.deps(orgAdmin, stack, {manifest: async (rp) => manifestFor(...worlds)(rp)});
    const req = w.createReq(stack, ru, {acknowledgePrivacy: o.personal !== undefined && o.personal !== false});
    const r = await createMirror(d, req);
    if (!r.ok) throw new Error(`create refused: ${r.code}`);
    await w.drive(d, ru, r.revisionId, {}, {stopWhenTerminal: false});
    return {stack, ru, d, worlds, req, mirrorId: r.mirrorId, r1: r.revisionId};
}
async function newerRp(c: Ctx, o: Parameters<typeof nextRp>[3] = {}): Promise<W17> {
    const x = await nextRp(w.t, c.worlds[c.worlds.length - 1] as W17, w.key, o);
    c.worlds.push(x);
    return x;
}
const preview = (c: Ctx, rpId: string | null, d: Ctx["d"] = c.d) => previewMirrorRefresh(d, {mirrorId: c.mirrorId, rpId});
const okPreview = async (c: Ctx, rpId: string | null) => { const r = await preview(c, rpId); if (!r.ok) throw new Error(`preview refused: ${r.code}`); return r.preview; };
const COUNT_TABLES = ["fork_mirror", "fork_mirror_revision", "fork_restore_plan", "fork_agent_task", "fork_mirror_event", "fork_mirror_task"] as const;
const counts = async () => Object.fromEntries(await Promise.all(COUNT_TABLES.map(async (t) => [t, Number((await w.q(`select count(*)::int n from ${t}`))[0].n)])));
const deniedAudits = (reason?: string) => w.q("select redacted_details d from fork_audit_event where action='fork.mirror.refresh_preview' and result='denied' order by seq").then((r) => r.filter((x) => !reason || x.d?.reason === reason));

/** a second (older or newer) succeeded probe of the mirror, cloned from the first one's task row */
async function addProbe(c: Ctx, o: {status: "succeeded" | "failed"; finishedAgoMs: number; free: number; mem: number; attempt: number}) {
    const src = (await w.q(`select j.task_id id, j.revision_id from fork_mirror_task j join fork_agent_task t on t.id=j.task_id join fork_mirror_revision r on r.id=j.revision_id where r.mirror_id=$1 and j.step='probe' order by j.attempt limit 1`, [c.mirrorId]))[0];
    const fin = new Date(w.now().getTime() - o.finishedAgoMs).toISOString();
    const nid = (await w.q(`insert into fork_agent_task (id, agent_id, agent_name, enroll_id, type, requires, seq, envelope_text, signature, kid, payload_sha256, status, attempts, result, created_by, created_at, not_after, finished_at)
        select gen_random_uuid(), agent_id, agent_name, enroll_id, type, requires, seq + 100000 + $2, envelope_text, signature, kid, payload_sha256, $3, 0, $4::jsonb, created_by, created_at, not_after, $5::timestamptz from fork_agent_task where id=$1 returning id`,
        [src.id, o.attempt, o.status, JSON.stringify({roots: [{path: "/srv/portabase-mirrors", shared: true, free_bytes: o.free}], mem_available_bytes: o.mem}), fin]))[0].id;
    await w.q("insert into fork_mirror_task (revision_id, step, attempt, task_type, task_id, created_at) values ($1,'probe',$2,'mirror_probe',$3,now())", [src.revision_id, o.attempt, nid]);
}

describe("P-1 candidates", () => {
    it("verified + unpurged + same stack + strictly newer, newest first, at most 20", async () => {
        const c = await make();
        const made: W17[] = [];
        for (let i = 0; i < 22; i++) made.push(await newerRp(c));
        await w.q("update fork_recovery_point set purged_at=now() where id=$1", [made[3]!.rp]); // purged
        const pending = await newerRp(c, {status: "pending_verification"});
        const other = await w.world(false); // another stack's (verified) backup
        const p = await okPreview(c, null);
        expect(p.candidates.length).toBe(20);
        const ids = p.candidates.map((x) => x.id);
        expect(ids).not.toContain(pending.rp);
        expect(ids).not.toContain(other.rp);
        expect(ids).not.toContain(made[3]!.rp);
        expect(ids).not.toContain(c.stack.rp); // the active revision's own (equal sequence) backup
        const seqs = p.candidates.map((x) => x.sequence);
        expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
        expect(p.selected).toBeNull();
        expect(p.mirror).toMatchObject({activeSeq: 1, status: "ready"});
        expect(Math.min(...seqs)).toBeGreaterThan(p.mirror.activeRpSequence);
    });
    it("none newer ⇒ empty list (the dialog shows the empty state)", async () => {
        const c = await make();
        expect((await okPreview(c, null)).candidates).toEqual([]);
    });
});

describe("P-2 selected plan numbers", () => {
    it("requiredDiskBytes = ceil(neededBytes × 1.1), memNeed = limit × services, outcome ready", async () => {
        const c = await make();
        const b = await newerRp(c, {plaintextSize: 5000});
        const p = await okPreview(c, b.rp);
        expect(p.selected).toMatchObject({rpId: b.rp, outcome: "ready", blockers: [], sizeUnknown: false});
        const loaded = await loadPlanInput(w.t.db, {rpId: b.rp, targetAgentId: c.ru.agentId, purpose: "mirror", mode: "new_stack", mappings: {...(await import("@/fork/restore/schema")).EMPTY_MAPPINGS, target_project: "pbm-x-r2", restore_root: forkEnv().FORK_MIRROR_ROOT}}, {principal: orgAdmin, organizationId: w.org, now: w.now()});
        if (!loaded.ok) throw new Error("plan input");
        const need = neededBytes(planRestore(loaded.input).plan);
        expect(need).toBeGreaterThan(0);
        expect(p.selected?.requiredDiskBytes).toBe(Math.ceil(need * 1.1));
        const services = ((await w.rev(c.r1)).services as unknown[]).length;
        expect(p.selected?.memNeedBytes).toBe(1073741824 * Math.max(1, services));
    });
});

describe("P-3 lastCapacity", () => {
    it("null before any probe exists; otherwise the newest SUCCEEDED probe (a newer FAILED one and an older succeeded one lose)", async () => {
        const c = await make();
        await newerRp(c);
        // the create flow already left one succeeded probe (free 1e12, mem 64 GiB): add an older one and a newer failed one
        await addProbe(c, {status: "succeeded", finishedAgoMs: 10 * 86_400_000, free: 111, mem: 222, attempt: 2});
        await addProbe(c, {status: "failed", finishedAgoMs: 0, free: 333, mem: 444, attempt: 3});
        const p = await okPreview(c, null);
        expect(p.lastCapacity).toMatchObject({freeDiskBytes: 1e12, memAvailableBytes: 64 * 1024 ** 3});
        expect(Date.parse(p.lastCapacity!.at)).toBeGreaterThan(w.now().getTime() - 10 * 86_400_000);
        await w.q("delete from fork_mirror_task where step='probe' and revision_id in (select id from fork_mirror_revision where mirror_id=$1)", [c.mirrorId]);
        expect((await okPreview(c, null)).lastCapacity).toBeNull();
    });
});

describe("P-4 refusals (each denial audited)", () => {
    it("rp_not_newer (the active backup), rp_purged, rp_not_verified, not_found (other stack / random uuid)", async () => {
        const c = await make();
        const b = await newerRp(c);
        const pend = await newerRp(c, {status: "pending_verification"});
        const purged = await newerRp(c);
        await w.q("update fork_recovery_point set purged_at=now() where id=$1", [purged.rp]);
        const other = await w.world(false);
        const code = async (rp: string) => { const r = await preview(c, rp); return r.ok ? "ok" : r.code; };
        expect(await code(c.stack.rp)).toBe("rp_not_newer");
        expect(await code(purged.rp)).toBe("rp_purged");
        expect(await code(pend.rp)).toBe("rp_not_verified");
        expect(await code(other.rp)).toBe("not_found");
        expect(await code("00000000-0000-4000-8000-0000000000ff")).toBe("not_found");
        expect(await code(b.rp)).toBe("ok");
        expect((await deniedAudits()).length).toBeGreaterThanOrEqual(5);
    });
    it("mirror_state_invalid (stopped, refreshing), mirrors_disabled, forbidden (member), foreign org = not_found, invalid_input", async () => {
        const c = await make();
        const b = await newerRp(c);
        const code = async (d: Ctx["d"], raw: unknown = {mirrorId: c.mirrorId, rpId: b.rp}) => { const r = await previewMirrorRefresh(d, raw); return r.ok ? "ok" : r.code; };
        for (const st of ["stopped", "refreshing"]) {
            await w.q("update fork_mirror set status=$2 where id=$1", [c.mirrorId, st]);
            expect(await code(c.d), st).toBe("mirror_state_invalid");
        }
        await w.q("update fork_mirror set status='ready' where id=$1", [c.mirrorId]);
        w.flag.on = false;
        expect(await code(c.d)).toBe("mirrors_disabled");
        w.flag.on = true;
        expect(await code({...c.d, principal: member})).toBe("forbidden");
        expect(await code({...c.d, principal: foreign})).toBe("not_found");
        expect(await code(c.d, {mirrorId: c.mirrorId, rpId: b.rp, extra: 1})).toBe("invalid_input");
        expect(await code(c.d, {mirrorId: "nope", rpId: null})).toBe("invalid_input");
        expect(await code({...c.d, principal: null})).toBe("forbidden");
        const reasons = (await deniedAudits()).map((x) => x.d.reason);
        for (const r of ["mirror_state_invalid", "mirrors_disabled", "forbidden", "not_found", "invalid_input"]) expect(reasons, r).toContain(r);
    });
});

describe("P-5 writes nothing", () => {
    it("row counts, updated_at and the success audit rows are identical after three previews", async () => {
        const c = await make();
        const b = await newerRp(c);
        const before = await counts();
        const upd = (await w.q("select updated_at from fork_mirror where id=$1", [c.mirrorId]))[0].updated_at;
        const auditBefore = Number((await w.q("select count(*)::int n from fork_audit_event where action='fork.mirror.refresh_preview'"))[0].n);
        for (const rp of [null, b.rp, b.rp]) await okPreview(c, rp);
        expect(await counts()).toEqual(before);
        expect((await w.q("select updated_at from fork_mirror where id=$1", [c.mirrorId]))[0].updated_at).toEqual(upd);
        expect(Number((await w.q("select count(*)::int n from fork_audit_event where action='fork.mirror.refresh_preview'"))[0].n)).toBe(auditBefore); // successes are not audited
    });
});

describe("P-6 value-free output", () => {
    it("the preview JSON has no root, workspace, project, URL, secret or manifest text; the strict schema parses", async () => {
        const c = await make({personal: true});
        const b = await newerRp(c);
        const p = await okPreview(c, b.rp);
        expect(() => RefreshPreview.parse(p)).not.toThrow();
        const text = JSON.stringify(p);
        const rev = await w.rev(c.r1);
        for (const bad of [forkEnv().FORK_MIRROR_ROOT, "/srv", String(rev.workspace), String(rev.project), "pbm-", "://", "SECRET", "PASSWORD", "manifest", c.req.name === "" ? "x" : "workspace"]) expect(text, bad).not.toContain(bad);
        expect(p.containsPersonalData).toBe(true);
    });
});

describe("P-7 appChanged", () => {
    it("equal inventory hash ⇒ false, different ⇒ true, either null ⇒ null", async () => {
        const c = await make();
        const b = await newerRp(c);
        const set = (rp: string, h: string | null) => w.q("update fork_recovery_point set inventory_hash=$2 where id=$1", [rp, h]);
        await set(c.stack.rp, "a".repeat(64)); await set(b.rp, "a".repeat(64));
        expect((await okPreview(c, b.rp)).selected?.appChanged).toBe(false);
        await set(b.rp, "b".repeat(64));
        expect((await okPreview(c, b.rp)).selected?.appChanged).toBe(true);
        await set(b.rp, null);
        expect((await okPreview(c, b.rp)).selected?.appChanged).toBeNull();
        await set(b.rp, "b".repeat(64)); await set(c.stack.rp, null);
        expect((await okPreview(c, b.rp)).selected?.appChanged).toBeNull();
    });
});

describe("P-8 detail facts and lastOp", () => {
    it("loadMirrorRefreshFacts matches the candidate predicate", async () => {
        const c = await make();
        expect(await loadMirrorRefreshFacts(w.t.db, c.mirrorId)).toEqual({newerVerifiedCount: 0});
        const made: W17[] = [];
        for (let i = 0; i < 3; i++) made.push(await newerRp(c));
        await newerRp(c, {status: "pending_verification"});
        await w.q("update fork_recovery_point set purged_at=now() where id=$1", [made[0]!.rp]);
        expect(await loadMirrorRefreshFacts(w.t.db, c.mirrorId)).toEqual({newerVerifiedCount: 2});
        expect((await okPreview(c, null)).candidates.length).toBe(2);
    });
    const extras = (c: Ctx) => loadMirrorDetailExtras(w.t.db, c.mirrorId, {now: w.now(), serverUrl: "http://dash.test", canManage: true});
    const ev = (c: Ctx, from: string, to: string, code: string | null, plus = 0) => addEvent(w.t.db, {mirrorId: c.mirrorId, revisionId: null, kind: "state_changed", at: new Date(w.now().getTime() + 60_000 + plus), fromState: from, toState: to, code, details: {scope: "mirror"}});
    it("refresh_failed (→ ready + code), rollback_failed, rollback_broken (→ failed) carry `from`; stop_failed is unchanged; a newer success hides an old failure", async () => {
        const c = await make();
        expect((await extras(c)).lastOp).toBeNull();
        await ev(c, "refreshing", "ready", "insufficient_disk");
        expect((await extras(c)).lastOp).toMatchObject({status: "ready", from: "refreshing", code: "insufficient_disk"});
        await ev(c, "rolling_back", "ready", "route_failed", 1000);
        expect((await extras(c)).lastOp).toMatchObject({status: "ready", from: "rolling_back", code: "route_failed"});
        await ev(c, "rolling_back", "failed", "route_failed", 2000);
        expect((await extras(c)).lastOp).toMatchObject({status: "failed", from: "rolling_back"});
        await ev(c, "stopping", "failed", "stop_incomplete", 3000);
        expect((await extras(c)).lastOp).toMatchObject({status: "failed", from: "stopping", code: "stop_incomplete"}); // W23 regression
        await ev(c, "ready", "refreshing", null, 4000); // a newer op started: the old failure is gone
        expect((await extras(c)).lastOp).toBeNull();
        await ev(c, "refreshing", "ready", null, 5000); // a success
        expect((await extras(c)).lastOp).toBeNull();
    });
    it("an unexpected from_state never breaks the strict parse (a string, not an enum)", async () => {
        const c = await make();
        await ev(c, "weird_state", "ready", "internal_error");
        expect((await extras(c)).lastOp).toMatchObject({from: "weird_state"});
    });
});
