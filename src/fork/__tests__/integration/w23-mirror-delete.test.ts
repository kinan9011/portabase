import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {advanceMirrorDeletes} from "@/fork/mirror/lifecycle";
import {createMirror, deleteMirror, retryMirrorWipe} from "@/fork/mirror/service";
import {tickAllMirrors} from "@/fork/mirror/tick";
import {advanceMirrorWipe, isWipeEligible} from "@/fork/mirror/wipe";
import {undesignateRunner} from "@/fork/runner/service";
import {mirrorWorld, type MirrorWorld, type Script} from "@/fork/__tests__/w22a-world";

let w: MirrorWorld;
let sys: ForkPrincipal, orgAdmin: ForkPrincipal, member: ForkPrincipal, foreign: ForkPrincipal;
beforeAll(async () => { w = await mirrorWorld(); sys = await w.user("sys"); orgAdmin = await w.user("admin"); member = await w.user("member"); foreign = await w.user("admin", w.otherOrg); });
afterAll(async () => { await w?.close(); });
beforeEach(() => { w.reset(); w.flag.on = true; });

type Ctx = Awaited<ReturnType<typeof make>>;
async function make(script: Script = {}, o: {drive?: boolean} = {}) {
    const stack = await w.world(false);
    await w.setSeq(stack);
    const ru = await w.runner();
    const d = w.deps(orgAdmin, stack);
    const req = w.createReq(stack, ru);
    const r = await createMirror(d, req);
    if (!r.ok) throw new Error(`create refused: ${r.code}`);
    if (o.drive !== false) await w.drive(d, ru, r.revisionId, script, {stopWhenTerminal: false});
    return {stack, ru, d, req, mirrorId: r.mirrorId, revisionId: r.revisionId, port: r.hostPort};
}
/** tick → fake runner until the mirror is `deleted` (or `max` rounds); returns the runner tasks that were answered. */
async function driveDelete(c: Ctx, script: Script = {}, max = 60) {
    const seen: {type: string; payload: Record<string, any>}[] = [];
    for (let i = 0; i < max; i++) {
        await tickAllMirrors(c.d);
        if ((await w.mirrorRow(c.mirrorId)).status === "deleted") break;
        const s = await w.runnerStep(c.ru, script);
        if (s) seen.push({type: s.type, payload: s.payload});
    }
    return seen;
}
const ID = (n: string) => n;

describe("deleteMirror: a READY mirror is deleted through the verified wipe", () => {
    it("ready → deleting → wipe + independent probe of THIS revision only → deleted; port, name and the runner are free again", async () => {
        const c = await make();
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("ready");
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name})).toEqual({ok: true});
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("deleting");
        w.advance(1000); // the world's clock is frozen: distinct timestamps keep the event order deterministic
        const seen = await driveDelete(c);
        const types = seen.map((s) => s.type);
        expect(types).toEqual(["mirror_wipe", "mirror_probe"]); // wipe, then the independent check
        const wipe = seen[0]!.payload;
        expect(wipe.restore_id).toBe(c.revisionId); // owner id = this revision (agent removes only resources it owns)
        expect(String(wipe.workspace)).toMatch(/^\/srv\/portabase-mirrors\//);
        const m = await w.mirrorRow(c.mirrorId);
        expect(m.status).toBe("deleted");
        expect(m.deleted_at).not.toBeNull();
        expect((await w.rev(c.revisionId)).wipe_state).toBe("verified");
        expect((await w.rev(c.revisionId)).state).toBe("ready"); // the revision row is history: never rewritten
        // events + audit trail
        const ev = (await w.events(c.mirrorId)).filter((e) => e.details?.scope === "mirror").map((e) => `${e.from_state}>${e.to_state}`);
        expect(ev).toEqual(["ready>deleting", "deleting>deleted"]);
        const aud = (await w.audits("fork.mirror.delete")).filter((a) => a.resource_id === c.mirrorId);
        expect(aud.map((a) => a.d?.phase)).toEqual(["requested", "done"]);
        // the name is reusable and the loopback port is free again on the same runner; the runner can be undesignated (no mirrors left holding it)
        const stack2 = await w.world(false);
        await w.setSeq(stack2);
        const again = await createMirror(w.deps(orgAdmin, stack2), w.createReq(stack2, c.ru, {name: c.req.name}));
        expect(again).toMatchObject({ok: true, hostPort: c.port});
    });

    it("undesignating the runner is no longer refused once its only mirror is deleted", async () => {
        const c = await make();
        const sysDeps = {...w.channelDeps(sys.userId), mirrorsEnabled: () => true, principal: sys};
        expect(await undesignateRunner(sysDeps, {agentId: c.ru.agentId})).toMatchObject({ok: false, code: "mirrors_exist"});
        await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name});
        await driveDelete(c);
        expect(await undesignateRunner(sysDeps, {agentId: c.ru.agentId})).toMatchObject({ok: true});
    });

    it("a READY copy readied 3 h ago is deleted (the wipe budget starts when the wipe is armed, not at readied_at)", async () => {
        const c = await make();
        const past = new Date(Date.now() - 3 * 3600e3);
        await w.q("update fork_mirror_revision set finished_at=$2, readied_at=$2, activated_at=$2 where id=$1", [c.revisionId, past]);
        await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name});
        await driveDelete(c);
        const rev = await w.rev(c.revisionId);
        expect({wipe: rev.wipe_state, reason: rev.wipe_reason}).toEqual({wipe: "verified", reason: null});
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("deleted");
    });

    it("a failed creation whose wipe is already verified is deleted on the next tick, without a new task", async () => {
        const c = await make({mirror_apply: {status: "failed", reason: "apply_failed"}});
        const rev = await w.rev(c.revisionId);
        expect(rev.state).toBe("failed");
        expect(["verified", "not_needed"]).toContain(rev.wipe_state);
        const before = (await w.journal(c.revisionId)).length;
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name})).toEqual({ok: true});
        await tickAllMirrors(c.d);
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("deleted");
        expect((await w.journal(c.revisionId)).length).toBe(before);
    });
});

describe("deleteMirror: failures, retry and the never-wipe-live rule", () => {
  it("a failed wipe leaves the mirror deleting; Retry wipe is allowed on the READY revision of a deleting mirror only", async () => {
        const c = await make();
        // READY revision of a mirror that is NOT deleting: retry refused (nothing failed)
        expect(await retryMirrorWipe(c.d, {revisionId: c.revisionId})).toMatchObject({ok: false, code: "not_failed"});
        await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name});
        await driveDelete(c, {mirror_wipe: {status: "failed", reason: "wipe_incomplete"}}, 12);
        let rev = await w.rev(c.revisionId);
        expect(rev.wipe_state).toBe("failed");
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("deleting");
        expect(await retryMirrorWipe(c.d, {revisionId: c.revisionId})).toEqual({ok: true});
        await driveDelete(c);
        rev = await w.rev(c.revisionId);
        expect(rev.wipe_state).toBe("verified");
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("deleted");
    });

    it("NEVER-WIPE-LIVE: a READY revision of a mirror that is not deleting is never wiped, whatever calls the wipe", async () => {
        const c = await make();
        expect(isWipeEligible("ready", "ready")).toBe(false);
        expect(isWipeEligible("ready", "stopped")).toBe(false);
        expect(isWipeEligible("ready", "deleting")).toBe(true);
        expect(isWipeEligible("failed", "ready")).toBe(true);
        const before = (await w.journal(c.revisionId)).length;
        expect(await advanceMirrorWipe(c.d, c.revisionId)).toBe("gone");
        await tickAllMirrors(c.d);
        await tickAllMirrors(c.d);
        expect((await w.journal(c.revisionId)).length).toBe(before);
        expect((await w.rev(c.revisionId)).wipe_state).toBeNull();
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("ready");
    });

    it("the mirror is not marked deleted while a wipe is still running", async () => {
        const c = await make();
        await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name});
        await tickAllMirrors(c.d); // arms the wipe (task queued, nothing answered)
        expect((await w.rev(c.revisionId)).wipe_state).toBe("running");
        expect(await advanceMirrorDeletes(c.d)).toMatchObject({deleted: 0});
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("deleting");
    });
});

describe("deleteMirror: gates and refusals", () => {
    it("wrong name ⇒ confirmation_mismatch; extra keys and a 41-char name ⇒ invalid_input; status unchanged", async () => {
        const c = await make();
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: "nope"})).toMatchObject({ok: false, code: "confirmation_mismatch"});
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name, extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: "x".repeat(41)})).toMatchObject({ok: false, code: "invalid_input"});
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("ready");
    });

    it("an active creation ⇒ mirror_busy", async () => {
        const c = await make({}, {drive: false});
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name})).toMatchObject({ok: false, code: "mirror_busy"});
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("creating");
    });

    it("member ⇒ forbidden; another org ⇒ not_found; a revision id instead of a mirror id ⇒ not_found; anonymous ⇒ forbidden", async () => {
        const c = await make();
        expect(await deleteMirror({...c.d, principal: member}, {mirrorId: c.mirrorId, confirmName: c.req.name})).toMatchObject({ok: false, code: "forbidden"});
        expect(await deleteMirror({...c.d, principal: foreign}, {mirrorId: c.mirrorId, confirmName: c.req.name})).toMatchObject({ok: false, code: "not_found"});
        expect(await deleteMirror(c.d, {mirrorId: c.revisionId, confirmName: c.req.name})).toMatchObject({ok: false, code: "not_found"});
        expect(await deleteMirror({...c.d, principal: null}, {mirrorId: c.mirrorId, confirmName: c.req.name})).toMatchObject({ok: false, code: "forbidden"});
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("ready");
    });

    it("idempotent: a second delete (while deleting and after deleted) is ok and writes nothing new", async () => {
        const c = await make();
        await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name});
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: c.req.name})).toEqual({ok: true});
        await driveDelete(c);
        expect(await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: "ignored-when-gone"})).toEqual({ok: true});
        const mine = (await w.audits("fork.mirror.delete")).filter((a) => a.resource_id === c.mirrorId);
        expect(mine.map((a) => a.d?.phase)).toEqual(["requested", "done"]); // the repeats wrote nothing
    });

    it("works while configuration is locked and with the flag off (OD-W23-2): accepted, wipe verified, mirror deleted", async () => {
        const c = await make();
        const locked = {...c.d, configAllowed: async () => false, mirrorsEnabled: () => false};
        expect(await deleteMirror(locked, {mirrorId: c.mirrorId, confirmName: c.req.name})).toEqual({ok: true});
        const lockedCtx = {...c, d: locked} as Ctx;
        await driveDelete(lockedCtx);
        expect((await w.mirrorRow(c.mirrorId)).status).toBe("deleted");
        expect((await w.rev(c.revisionId)).wipe_state).toBe("verified");
    });

    it("rate limited after 10 calls per minute", async () => {
        const c = await make();
        let last: unknown = null;
        for (let i = 0; i < 12; i++) last = await deleteMirror(c.d, {mirrorId: c.mirrorId, confirmName: "nope"});
        expect(last).toMatchObject({ok: false, code: "rate_limited"});
        void ID;
    });
});
