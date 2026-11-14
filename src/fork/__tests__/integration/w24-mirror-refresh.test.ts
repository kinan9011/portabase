import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {startTestedFact} from "@/fork/mirror/facet";
import {advanceMirrorRetention} from "@/fork/mirror/lifecycle";
import {createMirror, deleteMirror, getMirrorAccess, getMirrorView, refreshMirror, rollbackMirror, startMirror, stopMirror} from "@/fork/mirror/service";
import {tickAllMirrors} from "@/fork/mirror/tick";
import {RULES_SHA256} from "@/fork/policy/rules";
import {REVISION_MAX_AGE_DAYS} from "@/fork/mirror/vocab";
import {mirrorWorld, type MirrorWorld, type Script} from "@/fork/__tests__/w22a-world";
import {manifestFor, nextRp} from "@/fork/__tests__/w24-world";
import type {W17} from "@/fork/__tests__/w17-world";

let w: MirrorWorld;
let orgAdmin: ForkPrincipal, member: ForkPrincipal, foreign: ForkPrincipal;
beforeAll(async () => { w = await mirrorWorld(); orgAdmin = await w.user("admin"); member = await w.user("member"); foreign = await w.user("admin", w.otherOrg); });
afterAll(async () => { await w?.close(); });
beforeEach(() => { w.reset(); w.flag.on = true; w.principals.set(orgAdmin.userId, orgAdmin); });

const DAY = 86_400_000;
type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: task payloads
type Ctx = Awaited<ReturnType<typeof make>>;
/** a READY mirror of RP A (and a verified, strictly newer RP B of the same stack, not yet used) */
async function make(o: {personal?: boolean | null} = {}) {
    const stack = await w.world(o.personal === undefined ? false : o.personal);
    if (o.personal !== undefined && o.personal !== false) await w.q("update fork_stack set mirror_opt_in_at=now(), mirror_opt_in_by=$2 where id=$1", [stack.stack, w.adminId]); // ADR-009 §4 stack opt-in
    await w.setSeq(stack);
    const ru = await w.runner();
    const worlds: W17[] = [stack];
    const d = w.deps(orgAdmin, stack, {manifest: async (rp) => manifestFor(...worlds)(rp)});
    const req = w.createReq(stack, ru, {acknowledgePrivacy: o.personal !== undefined && o.personal !== false});
    const r = await createMirror(d, req);
    if (!r.ok) throw new Error(`create refused: ${r.code}`);
    await w.drive(d, ru, r.revisionId, {}, {stopWhenTerminal: false});
    const c = {stack, ru, d, worlds, req, mirrorId: r.mirrorId, r1: r.revisionId, ids: [r.revisionId] as string[]};
    return c;
}
/** a newer RP of the same stack, registered with the context's manifest server */
async function newerRp(c: Ctx, o: Parameters<typeof nextRp>[3] = {}): Promise<W17> {
    const latest = c.worlds[c.worlds.length - 1] as W17;
    const x = await nextRp(w.t, latest, w.key, o);
    c.worlds.push(x);
    return x;
}
const mirrorRow = (c: Ctx) => w.mirrorRow(c.mirrorId);
const status = async (c: Ctx) => (await mirrorRow(c)).status as string;
const confirm = (c: Ctx) => c.req.name as string;
const refreshReq = (c: Ctx, x: W17, over: Record<string, unknown> = {}) => ({mirrorId: c.mirrorId, rpId: x.rp, confirmName: confirm(c), acknowledgePrivacy: false, ...over});
async function revisions(c: Ctx) { return w.q("select * from fork_mirror_revision where mirror_id=$1 order by seq", [c.mirrorId]); }
async function journalOf(c: Ctx, step?: string) {
    return w.q(`select r.seq, r.id as revision_id, j.step, j.attempt, j.created_at from fork_mirror_task j join fork_mirror_revision r on r.id=j.revision_id where r.mirror_id=$1 ${step ? "and j.step=$2" : ""} order by j.created_at, j.step, j.attempt`, step ? [c.mirrorId, step] : [c.mirrorId]);
}
/** tick → fake runner until `until(mirror row)` holds (or `max` rounds). Returns every task the runner answered. `rpWorld` sets the manifest sequence the fake stage reports. */
async function driveUntil(c: Ctx, until: (m: Doc) => boolean | Promise<boolean>, script: Script = {}, o: {max?: number; d?: Ctx["d"]; before?: () => Promise<void>} = {}) {
    const seen: {type: string; payload: Doc}[] = [];
    for (let i = 0; i < (o.max ?? 120); i++) {
        await o.before?.();
        await tickAllMirrors(o.d ?? c.d);
        w.advance(1000);
        if (await until(await mirrorRow(c))) break;
        const s = await w.runnerStep(c.ru, script);
        if (s) seen.push({type: s.type, payload: s.payload});
    }
    return seen;
}
/** one full successful refresh A→B; returns the new revision id and the tasks seen */
async function doRefresh(c: Ctx, x: W17, script: Script = {}) {
    await w.setSeq(x);
    const r = await refreshMirror(c.d, refreshReq(c, x));
    if (!r.ok) throw new Error(`refresh refused: ${r.code}`);
    const seen = await driveUntil(c, async (m) => m.status === "ready", script);
    c.ids.push(r.revisionId);
    return {revisionId: r.revisionId, seen};
}
/** until the wipe phase of `revisionId` is finished */
const wiped = async (c: Ctx, id: string, script: Script = {}) => { await driveUntil(c, async () => ["verified", "not_needed"].includes((await w.rev(id)).wipe_state), script); return w.rev(id); };

describe("refreshMirror: happy path (I-1)", () => {
    it("builds an independent revision while r1 keeps serving; switches only after READY; commit moves the pointer, route and op; r1 is stopped and retained", async () => {
        const c = await make();
        const b = await newerRp(c);
        const r1 = await w.rev(c.r1);
        await w.setSeq(b);
        const r = await refreshMirror(c.d, refreshReq(c, b));
        expect(r).toMatchObject({ok: true});
        if (!r.ok) return;
        let m = await mirrorRow(c);
        expect(m).toMatchObject({status: "refreshing", op_revision_id: r.revisionId, active_revision_id: c.r1});
        expect(m.route_port).toBeGreaterThanOrEqual(41000);
        const r2 = await w.rev(r.revisionId);
        expect(r2).toMatchObject({seq: 2, project: `pbm-${c.req.name}-r2`, rp_id: b.rp, state: "validating"});
        expect(r2.host_port).not.toBe(r1.host_port);
        expect(m.route_port).not.toBe(r2.host_port);
        // while r2 builds, r1 still answers: access info = r1's own port, allowed during `refreshing`
        const during = await getMirrorAccess(c.d, {mirrorId: c.mirrorId});
        expect(during).toMatchObject({ok: true, access: {hostPort: r1.host_port}});
        // r2 becomes READY: the pointer is NOT flipped by activation (M1); activated_at stays NULL until the route switched
        const seen = await driveUntil(c, async () => (await w.rev(r.revisionId)).state === "ready");
        const ready = await w.rev(r.revisionId);
        expect(ready.activated_at).toBeNull();
        expect((await mirrorRow(c)).active_revision_id).toBe(c.r1);
        expect((await mirrorRow(c)).status).toBe("refreshing");
        // let the op finish
        seen.push(...(await driveUntil(c, async (x) => x.status === "ready")));
        m = await mirrorRow(c);
        expect(m).toMatchObject({status: "ready", active_revision_id: r.revisionId, route_revision_id: r.revisionId, op_revision_id: null});
        const r2done = await w.rev(r.revisionId);
        expect(r2done.activated_at).not.toBeNull();
        // the route task carried r2's header (the revision the route points to) and the stable route port
        const route = seen.filter((s) => s.type === "mirror_route");
        expect(route).toHaveLength(1);
        expect(route[0]?.payload).toMatchObject({action: "switch", restore_id: r.revisionId, route_port: m.route_port, mirror_id: c.mirrorId, project: `pbm-${c.req.name}-r2`});
        // r1 was stopped AFTER the switch and is retained (READY, stopped, not retired)
        const stop = seen.filter((s) => s.type === "mirror_stop");
        expect(stop).toHaveLength(1);
        expect(stop[0]?.payload.restore_id).toBe(c.r1);
        expect(seen.findIndex((s) => s.type === "mirror_route")).toBeLessThan(seen.findIndex((s) => s.type === "mirror_stop"));
        expect(await w.rev(c.r1)).toMatchObject({state: "ready", retired_at: null, wipe_state: null});
        // events + audit (ids and codes only)
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "activated").map((e) => e.details)).toEqual([{fromRevisionId: c.r1}]);
        const phases = (await w.audits("fork.mirror.refresh")).filter((a) => a.resource_id === c.mirrorId).map((a) => a.d.phase);
        expect(phases).toEqual(expect.arrayContaining(["requested", "switched", "done"]));
        expect(JSON.stringify(await w.audits("fork.mirror.refresh"))).not.toContain("/srv/portabase-mirrors");
        // access now = the stable route port (≠ both revision ports)
        const after = await getMirrorAccess(c.d, {mirrorId: c.mirrorId});
        expect(after).toMatchObject({ok: true, access: {hostPort: m.route_port}});
        expect(m.route_port).not.toBe(r1.host_port);
        expect(m.route_port).not.toBe(r2done.host_port);
        // the start-tested fact is the newest READY revision of the stack
        expect((await startTestedFact(w.t.db, c.stack.stack))?.revisionId ?? null).not.toBeNull();
    }, 120_000);
});

describe("refreshMirror: a failed new revision never touches the active one (I-2, I-3, I-4)", () => {
    it("I-2: the new revision fails restoring the DB ⇒ r2 failed + wiped, mirror ready, active r1, no route task, no stop of r1, access unchanged", async () => {
        const c = await make();
        const b = await newerRp(c);
        await w.setSeq(b);
        const before = await getMirrorAccess(c.d, {mirrorId: c.mirrorId});
        const r = await refreshMirror(c.d, refreshReq(c, b));
        if (!r.ok) throw new Error(r.code);
        const script: Script = {mirror_db: {status: "failed", reason: "db_restore_failed"}};
        await driveUntil(c, async () => ["verified", "not_needed"].includes((await w.rev(r.revisionId)).wipe_state) && (await status(c)) === "ready", script);
        expect(await w.rev(r.revisionId)).toMatchObject({state: "failed", reason: "db_restore_failed", wipe_state: "verified"});
        expect(await mirrorRow(c)).toMatchObject({status: "ready", active_revision_id: c.r1, op_revision_id: null});
        expect(await journalOf(c, "route")).toHaveLength(0);
        expect((await journalOf(c, "stop")).length).toBe(0);
        expect(await w.rev(c.r1)).toMatchObject({state: "ready", retired_at: null, wipe_state: null});
        expect(await getMirrorAccess(c.d, {mirrorId: c.mirrorId})).toEqual(before);
        const failed = (await w.events(c.mirrorId)).filter((e) => e.kind === "failed" && e.details?.scope === "mirror");
        expect(failed.map((e) => e.code)).toEqual(["db_restore_failed"]);
    }, 120_000);

    it("I-3: a plan blocked at request time writes NOTHING (no revision row, no plan row) and leaves the mirror ready", async () => {
        const c = await make();
        const b = await newerRp(c);
        await w.q("update fork_recovery_point_artifact set presence='missing' where rp_id=$1", [b.rp]);
        const plans = (await w.q("select count(*)::int n from fork_restore_plan"))[0].n;
        const r = await refreshMirror(c.d, refreshReq(c, b));
        expect(r).toMatchObject({ok: false, code: "plan_blocked", blockers: ["compose_not_in_backup", "required_artifact_missing"]});
        expect((await revisions(c)).length).toBe(1);
        expect((await w.q("select count(*)::int n from fork_restore_plan"))[0].n).toBe(plans);
        expect(await mirrorRow(c)).toMatchObject({status: "ready", op_revision_id: null, route_port: null});
        const denied = await w.audits("fork.mirror.refresh");
        expect(denied.at(-1)).toMatchObject({result: "denied"});
    }, 120_000);

    it("I-4: disk below need×1.1, memory below the cap, or an unreported fact (refresh) ⇒ failed at `probe` before `stage`, wipe not_needed, active untouched; a creation without a free-disk fact still passes", async () => {
        const cases: {name: string; result: Record<string, unknown>; code: string}[] = [
            {name: "disk", result: {free_bytes: 1, mem: 64 * 1024 ** 3}, code: "insufficient_disk"},
            {name: "memory", result: {free_bytes: 1e12, mem: 1024}, code: "insufficient_memory"},
            {name: "unknown disk", result: {free_bytes: null, mem: 64 * 1024 ** 3}, code: "capacity_unknown"},
            {name: "unknown memory", result: {free_bytes: 1e12, mem: null}, code: "capacity_unknown"},
        ];
        for (const k of cases) {
            const c = await make();
            const b = await newerRp(c);
            await w.setSeq(b);
            const r = await refreshMirror(c.d, refreshReq(c, b));
            if (!r.ok) throw new Error(r.code);
            const script: Script = {mirror_probe: {result: {roots: [{path: "/srv/portabase-mirrors", shared: true, free_bytes: k.result.free_bytes}], workspace_state: "absent", arch: "x86_64", compose_version: "5.4.0",
                rules_sha256: RULES_SHA256, ...(k.result.mem === null ? {} : {mem_available_bytes: k.result.mem})}}};
            await driveUntil(c, async () => (await status(c)) === "ready" && ["verified", "not_needed"].includes((await w.rev(r.revisionId)).wipe_state), script);
            const r2 = await w.rev(r.revisionId);
            expect(r2, k.name).toMatchObject({state: "failed", reason: k.code, failed_step: "probe", wipe_state: "not_needed"});
            expect(await w.q("select 1 from fork_mirror_task where revision_id=$1 and step='stage'", [r.revisionId]), k.name).toHaveLength(0);
            expect(await mirrorRow(c), k.name).toMatchObject({status: "ready", active_revision_id: c.r1});
        }
        // creation: an unreported free disk keeps the old (fail-open) behaviour
        const stack = await w.world(false);
        await w.setSeq(stack);
        const ru = await w.runner();
        const d = w.deps(orgAdmin, stack);
        const r = await createMirror(d, w.createReq(stack, ru));
        if (!r.ok) throw new Error(r.code);
        const noFree: Script = {mirror_probe: {result: {roots: [{path: "/srv/portabase-mirrors", shared: true, free_bytes: null}], workspace_state: "absent", arch: "x86_64", compose_version: "5.4.0", rules_sha256: RULES_SHA256}}};
        const rev = await w.drive(d, ru, r.revisionId, noFree, {stopWhenTerminal: false});
        expect(rev.state).toBe("ready");
    }, 240_000);
});

describe("per-mirror lock (I-5)", () => {
    it("two concurrent refreshes ⇒ ONE revision, the second answers already:true with the same id; rollback / stop / delete during a refresh ⇒ mirror_busy; a refresh of a refreshing mirror is idempotent", async () => {
        const c = await make();
        const b = await newerRp(c);
        await w.setSeq(b);
        const [x, y] = await Promise.all([refreshMirror(c.d, refreshReq(c, b)), refreshMirror(c.d, refreshReq(c, b))]);
        expect(x.ok && y.ok).toBe(true);
        if (!x.ok || !y.ok) return;
        expect(x.revisionId).toBe(y.revisionId);
        expect([x.already, y.already].filter(Boolean)).toEqual([true]);
        expect((await revisions(c)).length).toBe(2);
        expect(await mirrorRow(c)).toMatchObject({status: "refreshing", op_revision_id: x.revisionId});
        // a third call while refreshing: idempotent, nothing new
        expect(await refreshMirror(c.d, refreshReq(c, b))).toEqual({ok: true, revisionId: x.revisionId, already: true});
        expect((await revisions(c)).length).toBe(2);
        expect(await rollbackMirror(c.d, {mirrorId: c.mirrorId, revisionId: c.r1, confirmName: confirm(c)})).toMatchObject({ok: false, code: "mirror_busy"});
        expect(await stopMirror(c.d, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "mirror_busy"});
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: confirm(c)})).toMatchObject({ok: false, code: "mirror_busy"});
        // the DB backstop: a second ACTIVE revision of the same mirror is a constraint error, not a second build
        await expect(w.q(`insert into fork_mirror_revision (mirror_id, organization_id, stack_id, seq, rp_id, rp_sequence, plan_hash, runner_agent_id, project, workspace, host_port, state, started_by, created_at, deadline_at, updated_at)
            select mirror_id, organization_id, stack_id, 99, rp_id, rp_sequence, plan_hash, null, 'pbm-x-r99', workspace, 41990, 'validating', started_by, now(), now() + interval '1 hour', now() from fork_mirror_revision where id=$1`, [x.revisionId])).rejects.toThrow(/fork_mirror_revision_one_active_mirror_uq/);
        // finish the build so later tests of this world start clean
        await driveUntil(c, async (m) => m.status === "ready");
    }, 180_000);
});

describe("route switch failures (I-6, I-7)", () => {
    const failRoute = (toRevision: (p: Doc) => boolean): Script => ({mirror_route: (p) => (toRevision(p) ? {status: "failed", reason: "route_smoke_failed"} : {result: {v: 1, route_port: p.route_port, switched: true, smoke: {status: "ok", http_status: 200}}})});
    it("I-6: the switch to r2 fails its smoke, the re-assert to r1 succeeds ⇒ r2 retired + wiped, mirror ready on r1, `route_failed` recorded, route pointer = r1", async () => {
        const c = await make();
        const b = await newerRp(c);
        await w.setSeq(b);
        const r = await refreshMirror(c.d, refreshReq(c, b));
        if (!r.ok) throw new Error(r.code);
        const seen = await driveUntil(c, async (m) => m.status === "ready", failRoute((p) => p.restore_id === r.revisionId));
        expect(await mirrorRow(c)).toMatchObject({status: "ready", active_revision_id: c.r1, op_revision_id: null, route_revision_id: c.r1});
        expect(seen.filter((s) => s.type === "mirror_route").map((s) => s.payload.restore_id)).toEqual([r.revisionId, c.r1]);
        const r2 = await w.rev(r.revisionId);
        expect(r2.retired_at).not.toBeNull();
        expect(r2.activated_at).toBeNull();
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "failed" && e.details?.scope === "mirror").map((e) => e.code)).toEqual(["route_failed"]);
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "retired").map((e) => e.code)).toEqual(["route_failed"]);
        expect(seen.some((s) => s.type === "mirror_stop")).toBe(false); // r1 is never stopped
        expect((await wiped(c, r.revisionId)).wipe_state).toBe("verified");
        expect(await getMirrorAccess(c.d, {mirrorId: c.mirrorId})).toMatchObject({ok: true}); // access is the route now (truthfully pointing at r1)
    }, 180_000);

    it("I-7: the switch fails AND the re-assert fails ⇒ mirror failed `route_failed` (honest), Stop and Delete stay possible", async () => {
        const c = await make();
        const b = await newerRp(c);
        await w.setSeq(b);
        const r = await refreshMirror(c.d, refreshReq(c, b));
        if (!r.ok) throw new Error(r.code);
        await driveUntil(c, async (m) => m.status === "failed", {mirror_route: {status: "failed", reason: "route_smoke_failed"}});
        const m = await mirrorRow(c);
        expect(m).toMatchObject({status: "failed", active_revision_id: c.r1, op_revision_id: null});
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "failed" && e.details?.scope === "mirror").map((e) => e.code)).toEqual(["route_failed"]);
        expect((await w.rev(r.revisionId)).retired_at).not.toBeNull();
        // Stop is allowed from `failed` (the active revision still exists); Delete too
        expect(await stopMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true});
        await driveUntil(c, async (x) => x.status === "stopped");
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: confirm(c)})).toEqual({ok: true});
    }, 180_000);
});

describe("rollback (I-8, I-9)", () => {
    it("I-8: r2 active, r1 retained ⇒ rollback re-gates r1 (OWN isolation probe first), switches the route back, commits, r2 rolled_back + wiped; r1's READY evidence is never rewritten", async () => {
        const c = await make();
        const b = await newerRp(c);
        const {revisionId: r2} = await doRefresh(c, b);
        const r1before = await w.rev(c.r1);
        w.advance(5000);
        const opStart = w.now();
        expect(await rollbackMirror(c.d, {mirrorId: c.mirrorId, revisionId: c.r1, confirmName: confirm(c)})).toEqual({ok: true});
        expect(await mirrorRow(c)).toMatchObject({status: "rolling_back", op_revision_id: c.r1, active_revision_id: r2});
        // the active revision keeps serving while the target is re-gated
        expect(await getMirrorAccess(c.d, {mirrorId: c.mirrorId})).toMatchObject({ok: true});
        const seen = await driveUntil(c, async (m) => m.status === "ready");
        const types = seen.map((s) => s.type);
        expect(types.indexOf("runner_probe")).toBeGreaterThanOrEqual(0);
        expect(types.indexOf("runner_probe")).toBeLessThan(types.indexOf("mirror_up"));
        expect(types.indexOf("mirror_up")).toBeLessThan(types.indexOf("mirror_check"));
        expect(types.indexOf("mirror_check")).toBeLessThan(types.indexOf("mirror_route"));
        expect(seen.find((s) => s.type === "mirror_up")?.payload.restore_id).toBe(c.r1);
        expect(seen.find((s) => s.type === "mirror_route")?.payload).toMatchObject({action: "switch", restore_id: c.r1});
        const m = await mirrorRow(c);
        expect(m).toMatchObject({status: "ready", active_revision_id: c.r1, route_revision_id: c.r1, op_revision_id: null});
        expect(await w.rev(r2)).toMatchObject({state: "rolled_back"});
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "rolled_back").map((e) => e.revision_id ?? null).length).toBe(1);
        const r1after = await w.rev(c.r1);
        expect(r1after.activated_at).not.toBeNull();
        expect({probe: r1after.probe_task_id, gates: r1after.gates, readied: r1after.readied_at}).toEqual({probe: r1before.probe_task_id, gates: r1before.gates, readied: r1before.readied_at});
        expect((await w.audits("fork.mirror.rollback")).filter((a) => a.resource_id === c.mirrorId).map((a) => a.d.phase)).toEqual(["requested", "done"]);
        expect(opStart.getTime()).toBeLessThan(w.now().getTime());
        expect((await wiped(c, r2)).wipe_state).toBe("verified");
        expect(await getMirrorAccess(c.d, {mirrorId: c.mirrorId})).toMatchObject({ok: true, access: {hostPort: m.route_port}});
    }, 240_000);

    it("I-9: the rolled-back target fails its check ⇒ cleanup stop of r1, mirror back to ready on r2, no route task in this op, r2 untouched", async () => {
        const c = await make();
        const b = await newerRp(c);
        const {revisionId: r2} = await doRefresh(c, b);
        const routesBefore = (await journalOf(c, "route")).length;
        w.advance(5000);
        expect(await rollbackMirror(c.d, {mirrorId: c.mirrorId, revisionId: c.r1, confirmName: confirm(c)})).toEqual({ok: true});
        const seen = await driveUntil(c, async (m) => m.status === "ready", {mirror_check: {result: {v: 1, services: [{service: "db", state: "running", health: "healthy"}, {service: "web", state: "running", health: "none"}], smoke: {status: "failed", http_status: null}}}});
        expect(await mirrorRow(c)).toMatchObject({status: "ready", active_revision_id: r2, op_revision_id: null});
        expect((await journalOf(c, "route")).length).toBe(routesBefore);
        expect(seen.filter((s) => s.type === "mirror_stop").map((s) => s.payload.restore_id)).toEqual([c.r1]);
        expect(await w.rev(r2)).toMatchObject({state: "ready", retired_at: null, wipe_state: null});
        expect(await w.rev(c.r1)).toMatchObject({state: "ready", wipe_state: null});
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "failed" && e.details?.scope === "mirror").map((e) => e.code)).toContain("smoke_failed");
    }, 240_000);
});

describe("retention (I-10, I-11)", () => {
    it("I-10: after two successful refreshes at most 2 READY revisions are kept; the oldest non-active is retired + wiped; the active one is never retired, even 31 days later (only flagged)", async () => {
        const c = await make();
        const r2 = (await doRefresh(c, await newerRp(c))).revisionId;
        expect((await w.rev(c.r1)).retired_at).toBeNull(); // kept = {r2 active, r1}: still within the cap of 2
        const r3 = (await doRefresh(c, await newerRp(c))).revisionId;
        await driveUntil(c, async () => (await w.rev(c.r1)).wipe_state === "verified");
        const rows = await revisions(c);
        const kept = rows.filter((r) => r.state === "ready" && r.retired_at === null && !["verified", "not_needed"].includes(r.wipe_state ?? ""));
        expect(kept.map((r) => r.id).sort()).toEqual([r2, r3].sort());
        expect((await w.rev(c.r1)).retired_at).not.toBeNull();
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "retired").map((e) => [e.revision_id ?? null, e.code]).length).toBe(1);
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "retired").map((e) => e.code)).toEqual(["superseded"]);
        expect((await mirrorRow(c)).active_revision_id).toBe(r3);
        // 31 days later: the retained non-active r2 is retired (age); the ACTIVE r3 is only flagged
        w.advance((REVISION_MAX_AGE_DAYS + 1) * DAY);
        await driveUntil(c, async () => (await w.rev(r2)).wipe_state === "verified");
        expect((await w.rev(r3)).retired_at).toBeNull();
        expect((await w.rev(r3)).state).toBe("ready");
        expect((await mirrorRow(c)).active_revision_id).toBe(r3);
        const v = await getMirrorView(c.d, {mirrorId: c.mirrorId});
        expect(v).toMatchObject({ok: true, view: {mirror: {retentionDue: true, opRevisionId: null}}});
        expect((await w.audits("fork.mirror.retention")).filter((a) => a.resource_id === c.mirrorId).map((a) => a.d.reason)).toEqual(["superseded", "max_age"]);
    }, 300_000);

    it("I-11: a mirror in refreshing / rolling_back / deleting is never retained; once ready again the over-age retained revision is retired (max_age); a fresh active revision is not flagged", async () => {
        const c = await make();
        await doRefresh(c, await newerRp(c));
        const fresh = await getMirrorView(c.d, {mirrorId: c.mirrorId});
        expect(fresh).toMatchObject({ok: true, view: {mirror: {retentionDue: false}}});
        w.advance((REVISION_MAX_AGE_DAYS + 1) * DAY);
        for (const s of ["refreshing", "rolling_back", "deleting"]) {
            await w.q("update fork_mirror set status=$2 where id=$1", [c.mirrorId, s]);
            expect(await advanceMirrorRetention(c.d), s).toEqual({retired: 0});
            expect((await w.rev(c.r1)).retired_at, s).toBeNull();
        }
        await w.q("update fork_mirror set status='ready' where id=$1", [c.mirrorId]);
        expect(await advanceMirrorRetention(c.d)).toEqual({retired: 1});
        expect((await w.rev(c.r1)).retired_at).not.toBeNull();
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "retired").map((e) => e.code)).toEqual(["max_age"]);
    }, 240_000);
});

describe("delete with a route (I-12)", () => {
    it("route REMOVE runs and is verified BEFORE any READY wipe; it is enqueued with configuration locked and the flag off; then every revision is wiped; route_port is NULL and reusable", async () => {
        const c = await make();
        const {revisionId: r2} = await doRefresh(c, await newerRp(c));
        const m0 = await mirrorRow(c);
        expect(m0.route_port).not.toBeNull();
        const locked = {...c.d, configAllowed: async () => false, mirrorsEnabled: () => false};
        expect(await deleteMirror(locked, {mirrorId: c.mirrorId, confirmName: confirm(c)})).toEqual({ok: true});
        const seen = await driveUntil(c, async (m) => m.status === "deleted", {}, {d: locked, max: 200});
        expect(await mirrorRow(c)).toMatchObject({status: "deleted", route_port: null, route_revision_id: null});
        const types = seen.map((s) => s.type);
        const iRoute = types.indexOf("mirror_route");
        const firstWipe = types.indexOf("mirror_wipe");
        expect(iRoute).toBeGreaterThanOrEqual(0);
        expect(iRoute).toBeLessThan(firstWipe);
        expect(seen[iRoute]?.payload).toMatchObject({action: "remove", route_port: m0.route_port});
        expect(types.filter((t) => t === "mirror_route")).toHaveLength(1);
        for (const id of [c.r1, r2]) expect((await w.rev(id)).wipe_state).toBe("verified");
        expect((await w.audits("fork.mirror.route")).filter((a) => a.resource_id === c.mirrorId).map((a) => a.d.phase)).toEqual(["removed"]);
        // the freed route port can be allocated again on the same runner (unique index only covers live mirrors)
        await w.q("insert into fork_mirror (organization_id, stack_id, runner_agent_id, runner_agent_name, name, policy, status, route_port, created_by, created_at, updated_at) values ($1,$2,$3,'r','reuse','{}','ready',$4,'u',now(),now())", [w.org, c.stack.stack, m0.runner_agent_id, m0.route_port]);
    }, 300_000);

    it("a failed route removal (agent result failed) keeps the mirror `deleting` and does NOT start the READY wipes; a second Delete click re-requests and then completes", async () => {
        const c = await make();
        await doRefresh(c, await newerRp(c));
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: confirm(c)})).toEqual({ok: true});
        const seen = await driveUntil(c, async () => (await w.events(c.mirrorId)).some((e) => e.kind === "failed" && e.code === "route_incomplete"), {mirror_route: {status: "failed", reason: "route_incomplete"}});
        expect(await status(c)).toBe("deleting");
        expect(seen.some((s) => s.type === "mirror_wipe")).toBe(false);
        w.advance(1000);
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: confirm(c)})).toEqual({ok: true}); // re-request
        await driveUntil(c, async (m) => m.status === "deleted", {}, {max: 200});
        expect(await mirrorRow(c)).toMatchObject({status: "deleted", route_port: null});
    }, 300_000);
});

describe("refusals + audit (I-13)", () => {
    const denials = async (c: Ctx) => (await w.audits("fork.mirror.refresh")).filter((a) => a.resource_id === c.mirrorId && a.result === "denied").map((a) => a.d.reason);
    it("refresh: locked, flag off, member, foreign org, wrong name, same / older / purged / unverified RP, privacy ack missing, runner not isolated, runner_busy, rate limit — every denial audited with a reason only", async () => {
        const c = await make({personal: null});
        const b = await newerRp(c);
        await w.setSeq(b);
        const req = (o: Record<string, unknown> = {}) => refreshReq(c, b, {acknowledgePrivacy: true, ...o});
        expect(await refreshMirror({...c.d, configAllowed: async () => false}, req())).toMatchObject({ok: false, code: "locked"});
        expect(await refreshMirror({...c.d, mirrorsEnabled: () => false}, req())).toMatchObject({ok: false, code: "mirrors_disabled"});
        expect(await refreshMirror({...c.d, principal: member}, req())).toMatchObject({ok: false, code: "forbidden"});
        expect(await refreshMirror({...c.d, principal: foreign}, req())).toMatchObject({ok: false, code: "not_found"});
        expect(await refreshMirror({...c.d, principal: null}, req())).toMatchObject({ok: false, code: "forbidden"});
        expect(await refreshMirror(c.d, req({confirmName: "nope"}))).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await refreshMirror(c.d, {...req(), extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await refreshMirror(c.d, req({rpId: c.stack.rp}))).toMatchObject({ok: false, code: "rp_not_newer"}); // the same RP the mirror runs
        expect(await refreshMirror(c.d, req({acknowledgePrivacy: false}))).toMatchObject({ok: false, code: "privacy_ack_required"}); // personal data unknown
        // an OLDER RP: bump the mirror's active rp_sequence above B
        await w.q("update fork_mirror_revision set rp_sequence = 1000 where id=$1", [c.r1]);
        expect(await refreshMirror(c.d, req())).toMatchObject({ok: false, code: "rp_not_newer"});
        await w.q("update fork_mirror_revision set rp_sequence = (select sequence from fork_recovery_point where id=$2) where id=$1", [c.r1, c.stack.rp]);
        await w.q("update fork_recovery_point set purged_at=now() where id=$1", [b.rp]);
        expect(await refreshMirror(c.d, req())).toMatchObject({ok: false, code: "rp_purged"});
        await w.q("update fork_recovery_point set purged_at=null, status='pending_verification' where id=$1", [b.rp]);
        expect(await refreshMirror(c.d, req())).toMatchObject({ok: false, code: "rp_not_verified"});
        await w.q("update fork_recovery_point set status='verified' where id=$1", [b.rp]);
        // runner not isolated: the isolation row is stale ⇒ refused before anything is written
        w.advance(25 * 3600e3);
        expect(await refreshMirror(c.d, req())).toMatchObject({ok: false, code: "runner_not_isolated"});
        expect((await revisions(c)).length).toBe(1);
        const reasons = await denials(c);
        expect(reasons).toEqual(expect.arrayContaining(["locked", "mirrors_disabled", "forbidden", "not_found", "confirmation_mismatch", "rp_not_newer", "privacy_ack_required", "rp_purged", "rp_not_verified", "runner_not_isolated"]));
        for (const a of await w.audits("fork.mirror.refresh")) expect(Object.keys(a.d).sort().every((k) => ["reason", "isolation", "rpId", "detail", "phase", "revisionId", "fromRevisionId", "rpSequence", "hostPort", "routePort"].includes(k))).toBe(true);
    }, 300_000);

    it("refresh: runner_busy while another mirror is being created on the same runner; rate limit (10 / min / user)", async () => {
        const c = await make();
        const b = await newerRp(c);
        await w.setSeq(b);
        // another mirror creating on the same runner
        const stack2 = await w.world(false);
        const other = await createMirror(w.deps(orgAdmin, stack2), w.createReq(stack2, c.ru));
        expect(other.ok).toBe(true);
        expect(await refreshMirror(c.d, refreshReq(c, b))).toMatchObject({ok: false, code: "runner_busy"});
        expect(await mirrorRow(c)).toMatchObject({status: "ready", op_revision_id: null});
        // rate limit: 10 per minute per user (a wrong name is cheap and still counted)
        let limited = 0;
        for (let i = 0; i < 12; i++) { const r = await refreshMirror(c.d, refreshReq(c, b, {confirmName: "x"})); if (!r.ok && r.code === "rate_limited") limited += 1; }
        expect(limited).toBeGreaterThan(0);
    }, 300_000);

    it("rollback: no_rollback_target for the active / never-activated / retired / wiped / foreign revision, wrong name, locked, flag off, member, foreign org, busy; only from ready", async () => {
        const c = await make();
        const {revisionId: r2} = await doRefresh(c, await newerRp(c));
        const req = (o: Record<string, unknown> = {}) => ({mirrorId: c.mirrorId, revisionId: c.r1, confirmName: confirm(c), ...o});
        expect(await rollbackMirror({...c.d, configAllowed: async () => false}, req())).toMatchObject({ok: false, code: "locked"});
        expect(await rollbackMirror({...c.d, mirrorsEnabled: () => false}, req())).toMatchObject({ok: false, code: "mirrors_disabled"});
        expect(await rollbackMirror({...c.d, principal: member}, req())).toMatchObject({ok: false, code: "forbidden"});
        expect(await rollbackMirror({...c.d, principal: foreign}, req())).toMatchObject({ok: false, code: "not_found"});
        expect(await rollbackMirror(c.d, req({confirmName: "nope"}))).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await rollbackMirror(c.d, {...req(), extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await rollbackMirror(c.d, req({revisionId: r2}))).toMatchObject({ok: false, code: "no_rollback_target"}); // the active one
        expect(await rollbackMirror(c.d, req({revisionId: "00000000-0000-4000-8000-000000000001"}))).toMatchObject({ok: false, code: "no_rollback_target"});
        await w.q("update fork_mirror_revision set activated_at=null where id=$1", [c.r1]);
        expect(await rollbackMirror(c.d, req())).toMatchObject({ok: false, code: "no_rollback_target"}); // never activated
        await w.q("update fork_mirror_revision set activated_at=now(), retired_at=now() where id=$1", [c.r1]);
        expect(await rollbackMirror(c.d, req())).toMatchObject({ok: false, code: "no_rollback_target"}); // retired
        await w.q("update fork_mirror_revision set retired_at=null, wipe_state='verified' where id=$1", [c.r1]);
        expect(await rollbackMirror(c.d, req())).toMatchObject({ok: false, code: "no_rollback_target"}); // wiped
        await w.q("update fork_mirror_revision set wipe_state=null where id=$1", [c.r1]);
        await w.q("update fork_mirror set status='stopped' where id=$1", [c.mirrorId]);
        expect(await rollbackMirror(c.d, req())).toMatchObject({ok: false, code: "mirror_state_invalid"});
        await w.q("update fork_mirror set status='ready' where id=$1", [c.mirrorId]);
        expect((await w.audits("fork.mirror.rollback")).filter((a) => a.resource_id === c.mirrorId && a.result === "denied").length).toBeGreaterThanOrEqual(10);
        // a good call is idempotent while rolling back
        w.reset();
        w.advance(5000);
        expect(await rollbackMirror(c.d, req())).toEqual({ok: true});
        expect(await rollbackMirror(c.d, req())).toEqual({ok: true, already: true});
        expect(await refreshMirror(c.d, refreshReq(c, c.worlds[1] as W17))).toMatchObject({ok: false, code: "mirror_busy"});
        await driveUntil(c, async (m) => m.status === "ready");
    }, 300_000);
});

describe("D31 + flag mid-operation (I-14)", () => {
    it("the requester loses the right after r2 is READY: the queued route task is cancelled, no route switch happens ⇒ refresh_failed reauth_failed, r2 retired, mirror ready on r1", async () => {
        const c = await make();
        const b = await newerRp(c);
        await w.setSeq(b);
        const r = await refreshMirror(c.d, refreshReq(c, b));
        if (!r.ok) throw new Error(r.code);
        // run until r2 is READY: the same tick enqueues the route task (still queued: the fake runner has not answered it)
        await driveUntil(c, async () => (await journalOf(c, "route")).length > 0);
        expect((await w.rev(r.revisionId)).state).toBe("ready");
        w.principals.set(orgAdmin.userId, member); // demoted
        const seen = await driveUntil(c, async (m) => m.status === "ready");
        w.principals.set(orgAdmin.userId, orgAdmin);
        expect(await mirrorRow(c)).toMatchObject({status: "ready", active_revision_id: c.r1, op_revision_id: null});
        expect(seen.filter((s) => s.type === "mirror_route")).toHaveLength(0); // the queued task was cancelled before the runner leased it
        expect((await w.rev(r.revisionId)).retired_at).not.toBeNull();
        expect((await w.events(c.mirrorId)).filter((e) => e.kind === "failed" && e.details?.scope === "mirror").map((e) => e.code)).toEqual(["reauth_failed"]);
        expect((await w.q("select status from fork_agent_task where id = (select task_id from fork_mirror_task where revision_id=$1 and step='route')", [r.revisionId]))[0].status).toBe("cancelled");
    }, 240_000);

    it("flag off during the build: forward steps wait, the revision deadline still applies ⇒ r2 failed run_timeout, refresh_failed, r1 untouched", async () => {
        const c = await make();
        const b = await newerRp(c);
        await w.setSeq(b);
        const r = await refreshMirror(c.d, refreshReq(c, b));
        if (!r.ok) throw new Error(r.code);
        await driveUntil(c, async () => (await w.rev(r.revisionId)).state === "staging");
        const off = {...c.d, mirrorsEnabled: () => false};
        const before = (await journalOf(c)).length;
        for (let i = 0; i < 3; i++) { await tickAllMirrors(off); w.advance(1000); await w.runnerStep(c.ru, {}); }
        expect((await journalOf(c)).length).toBeLessThanOrEqual(before + 1); // at most the already running step finishes; nothing new is started
        w.advance(5 * 3600e3 + 1); // beyond FORK_MIRROR_MAX_HOURS
        await driveUntil(c, async (m) => m.status === "ready", {}, {d: off});
        expect(await w.rev(r.revisionId)).toMatchObject({state: "failed", reason: "run_timeout"});
        expect(await mirrorRow(c)).toMatchObject({status: "ready", active_revision_id: c.r1});
    }, 240_000);
});

describe("seed preservation contract (I-15)", () => {
    it("the finalize payload of a refresh revision carries seed_from = {active revision id, its workspace}; a creation's finalize carries none", async () => {
        const c = await make();
        const created = await w.q("select 1");
        void created;
        const b = await newerRp(c);
        await w.setSeq(b);
        const r = await refreshMirror(c.d, refreshReq(c, b));
        if (!r.ok) throw new Error(r.code);
        const seen = await driveUntil(c, async () => (await w.rev(r.revisionId)).state === "ready");
        const fin = seen.filter((s) => s.type === "mirror_finalize");
        expect(fin).toHaveLength(1);
        const r1 = await w.rev(c.r1);
        expect(fin[0]?.payload.seed_from).toEqual({revision_id: c.r1, workspace: r1.workspace});
        await driveUntil(c, async (m) => m.status === "ready");
        // the creation of a fresh mirror: no seed_from
        const stack = await w.world(false);
        await w.setSeq(stack);
        const ru = await w.runner();
        const d = w.deps(orgAdmin, stack);
        const cr = await createMirror(d, w.createReq(stack, ru));
        if (!cr.ok) throw new Error(cr.code);
        const payloads: Doc[] = [];
        for (let i = 0; i < 60; i++) { await tickAllMirrors(d); const s = await w.runnerStep(ru, {}); if (s?.type === "mirror_finalize") payloads.push(s.payload); if ((await w.rev(cr.revisionId)).state === "ready") break; }
        expect(payloads).toHaveLength(1);
        expect("seed_from" in (payloads[0] as Doc)).toBe(false);
    }, 240_000);
});
