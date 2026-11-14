import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {startTestedFact} from "@/fork/mirror/facet";
import {createMirror, deleteMirror, getMirrorAccess, getMirrorView, refreshMirror, rollbackMirror, startMirror, stopMirror} from "@/fork/mirror/service";
import {tickAllMirrors} from "@/fork/mirror/tick";
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
    const stack = await w.world(o.personal ?? false);
    await w.setSeq(stack);
    const ru = await w.runner();
    const worlds: W17[] = [stack];
    const d = w.deps(orgAdmin, stack, {manifest: async (rp) => manifestFor(...worlds)(rp)});
    const req = w.createReq(stack, ru);
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
        const phases = (await w.audits("fork.mirror.refresh")).map((a) => a.d.phase);
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
