import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {startTestedFact} from "@/fork/mirror/facet";
import {createMirror, deleteMirror, getMirrorAccess, startMirror, stopMirror} from "@/fork/mirror/service";
import {tickAllMirrors} from "@/fork/mirror/tick";
import {mirrorWorld, type MirrorWorld, type Script} from "@/fork/__tests__/w22a-world";

let w: MirrorWorld;
let orgAdmin: ForkPrincipal, member: ForkPrincipal, foreign: ForkPrincipal;
beforeAll(async () => { w = await mirrorWorld(); orgAdmin = await w.user("admin"); member = await w.user("member"); foreign = await w.user("admin", w.otherOrg); });
afterAll(async () => { await w?.close(); });
beforeEach(() => { w.reset(); w.flag.on = true; w.principals.set(orgAdmin.userId, orgAdmin); });

type Ctx = Awaited<ReturnType<typeof make>>;
async function make(o: {drive?: boolean} = {}) {
    const stack = await w.world(false);
    await w.setSeq(stack);
    const ru = await w.runner();
    const d = w.deps(orgAdmin, stack);
    const req = w.createReq(stack, ru);
    const r = await createMirror(d, req);
    if (!r.ok) throw new Error(`create refused: ${r.code}`);
    if (o.drive !== false) await w.drive(d, ru, r.revisionId, {}, {stopWhenTerminal: false});
    return {stack, ru, d, req, mirrorId: r.mirrorId, revisionId: r.revisionId};
}
const status = async (c: Ctx) => (await w.mirrorRow(c.mirrorId)).status as string;
/** tick → fake runner until the mirror reaches one of `until` (or `max` rounds); returns the runner tasks answered. */
async function driveOp(c: Ctx, until: string[], script: Script = {}, o: {max?: number; d?: Ctx["d"]; between?: (type: string) => Promise<void>} = {}) {
    const seen: {type: string; payload: Record<string, any>}[] = [];
    for (let i = 0; i < (o.max ?? 60); i++) {
        await tickAllMirrors(o.d ?? c.d);
        w.advance(1000); // the world clock is frozen: distinct timestamps keep the event order deterministic
        if (until.includes(await status(c))) break;
        const s = await w.runnerStep(c.ru, script);
        if (s) { seen.push({type: s.type, payload: s.payload}); await o.between?.(s.type); }
    }
    return seen;
}
const scopeEvents = async (c: Ctx) => (await w.events(c.mirrorId)).filter((e) => e.details?.scope === "mirror" && e.kind === "state_changed");
async function stopped(): Promise<Ctx> {
    const c = await make();
    w.advance(1000);
    expect(await stopMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true});
    await driveOp(c, ["stopped"]);
    expect(await status(c)).toBe("stopped");
    w.advance(1000);
    return c;
}
const FAIL_SMOKE: Script = {mirror_check: {result: {v: 1, services: [{service: "db", state: "running", health: "healthy"}, {service: "web", state: "running", health: "none"}], smoke: {status: "failed", http_status: null}}}};

describe("stopMirror", () => {
    it("ready → stopping → the runner confirms → stopped; services exited, access refused, the creation's evidence untouched", async () => {
        const c = await make();
        const before = await w.rev(c.revisionId);
        w.advance(1000);
        expect(await stopMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true});
        expect(await status(c)).toBe("stopping");
        const seen = await driveOp(c, ["stopped"]);
        expect(seen.map((s) => s.type)).toEqual(["mirror_stop"]);
        expect(seen[0]!.payload.restore_id).toBe(c.revisionId); // owner id = this revision: the agent stops only what it owns
        expect(String(seen[0]!.payload.workspace)).toMatch(/^\/srv\/portabase-mirrors\//);
        expect(await status(c)).toBe("stopped");
        const after = await w.rev(c.revisionId);
        expect(after.services).toEqual([{service: "db", state: "exited"}, {service: "web", state: "exited"}]);
        expect({state: after.state, readied: after.readied_at, gates: after.gates, probe: after.probe_task_id}).toEqual({state: "ready", readied: before.readied_at, gates: before.gates, probe: before.probe_task_id});
        expect(await getMirrorAccess(c.d, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "mirror_not_ready"});
        expect((await scopeEvents(c)).map((e) => `${e.from_state}>${e.to_state}`)).toEqual(["ready>stopping", "stopping>stopped"]);
        expect((await w.audits("fork.mirror.stop")).filter((a) => a.resource_id === c.mirrorId).map((a) => a.d?.phase)).toEqual(["requested", "done"]);
    });

    it("a failed stop (stop_incomplete) ⇒ failed, the revision is kept, Stop can be retried and Delete works", async () => {
        const c = await make();
        w.advance(1000);
        await stopMirror(c.d, {mirrorId: c.mirrorId});
        await driveOp(c, ["failed"], {mirror_stop: {status: "failed", reason: "stop_incomplete"}});
        const m = await w.mirrorRow(c.mirrorId);
        expect(m.status).toBe("failed");
        expect(m.active_revision_id).toBe(c.revisionId);
        expect((await scopeEvents(c)).at(-1)).toMatchObject({to_state: "failed", code: "stop_incomplete"});
        expect(await getMirrorAccess(c.d, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "mirror_not_ready"});
        w.advance(1000);
        expect(await stopMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true}); // retry
        await driveOp(c, ["stopped"]);
        expect(await status(c)).toBe("stopped");
        // another mirror: failed stop, then Delete (the verified wipe removes everything owned)
        const d2 = await make();
        w.advance(1000);
        await stopMirror(d2.d, {mirrorId: d2.mirrorId});
        await driveOp(d2, ["failed"], {mirror_stop: {status: "failed", reason: "stop_incomplete"}});
        expect(await deleteMirror(d2.d, {mirrorId: d2.mirrorId, confirmName: d2.req.name})).toEqual({ok: true});
        w.advance(1000);
        await driveOp(d2, ["deleted"]);
        expect(await status(d2)).toBe("deleted");
    });

    it("works while configuration is locked and with the flag off (OD-W23-2)", async () => {
        const c = await make();
        const locked = {...c.d, configAllowed: async () => false, mirrorsEnabled: () => false};
        w.advance(1000);
        expect(await stopMirror(locked, {mirrorId: c.mirrorId})).toEqual({ok: true});
        await driveOp(c, ["stopped"], {}, {d: locked});
        expect(await status(c)).toBe("stopped");
    });

    it("an offline runner (3 expirations) ⇒ failed agent_offline; an operation over its budget ⇒ failed run_timeout", async () => {
        const a = await make();
        w.advance(1000);
        await stopMirror(a.d, {mirrorId: a.mirrorId});
        for (let i = 0; i < 12 && (await status(a)) === "stopping"; i++) { await tickAllMirrors(a.d); w.advance(10 * 60_000 + 1000); } // never answered, ttl 10 min
        expect(await status(a)).toBe("failed");
        expect((await scopeEvents(a)).at(-1)).toMatchObject({code: "agent_offline"});
        const b = await make();
        w.advance(1000);
        await stopMirror(b.d, {mirrorId: b.mirrorId});
        await tickAllMirrors(b.d); // task enqueued
        w.advance(30 * 60_000 + 1);
        await tickAllMirrors(b.d);
        expect(await status(b)).toBe("failed");
        expect((await scopeEvents(b)).at(-1)).toMatchObject({code: "run_timeout"});
    });

    it("refusals: member forbidden, foreign org not_found, creating ⇒ mirror_busy, a stopped / stopping mirror is idempotent, bad input", async () => {
        const c = await make();
        expect(await stopMirror({...c.d, principal: member}, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "forbidden"});
        expect(await stopMirror({...c.d, principal: foreign}, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "not_found"});
        expect(await stopMirror(c.d, {mirrorId: c.mirrorId, extra: 1})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await stopMirror({...c.d, principal: null}, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "forbidden"});
        const creating = await make({drive: false});
        expect(await stopMirror(creating.d, {mirrorId: creating.mirrorId})).toMatchObject({ok: false, code: "mirror_busy"});
        w.advance(1000);
        expect(await stopMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true});
        expect(await stopMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true}); // idempotent while stopping
        expect((await scopeEvents(c)).length).toBe(1);
    });
});

describe("startMirror", () => {
    it("stopped → starting: OWN isolation probe first, then up, then check ⇒ ready; the creation's probe, gates and readied_at are never rewritten; the start-tested fact is unchanged", async () => {
        const c = await stopped();
        const before = await w.rev(c.revisionId);
        const fact = await startTestedFact(w.t.db, c.stack.stackId ?? (await w.mirrorRow(c.mirrorId)).stack_id);
        expect(await startMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true});
        expect(await status(c)).toBe("starting");
        const seen = await driveOp(c, ["ready"]);
        expect(seen.map((s) => s.type)).toEqual(["runner_probe", "mirror_up", "mirror_check"]); // M13: up is never enqueued before the probe passed
        const after = await w.rev(c.revisionId);
        expect({probe: after.probe_task_id, readied: after.readied_at, gates: after.gates, state: after.state}).toEqual({probe: before.probe_task_id, readied: before.readied_at, gates: before.gates, state: "ready"}); // M14
        expect(after.services).toEqual([{service: "db", state: "running", health: "healthy"}, {service: "web", state: "running", health: "none"}]);
        expect(await status(c)).toBe("ready");
        const fact2 = await startTestedFact(w.t.db, (await w.mirrorRow(c.mirrorId)).stack_id);
        expect(fact2?.revisionId).toBe(fact?.revisionId);
        expect(fact2?.readiedAt.getTime()).toBe(fact?.readiedAt.getTime());
        expect((await scopeEvents(c)).map((e) => `${e.from_state}>${e.to_state}`)).toEqual(["ready>stopping", "stopping>stopped", "stopped>starting", "starting>ready"]);
        expect((await w.audits("fork.mirror.start")).filter((a) => a.resource_id === c.mirrorId).map((a) => a.d?.phase)).toEqual(["requested", "done"]);
        expect(await getMirrorAccess(c.d, {mirrorId: c.mirrorId})).toMatchObject({ok: true});
    });

    it("refused when the runner is not isolated at the precheck (status stays stopped)", async () => {
        const c = await stopped();
        await w.probeNow(c.ru, "reachable");
        expect(await startMirror(c.d, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "runner_not_isolated"});
        expect(await status(c)).toBe("stopped");
    });

    it("the start probe fails after the request ⇒ stopped with the code, and NO mirror_up task was ever enqueued", async () => {
        const c = await stopped();
        expect(await startMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true});
        const seen = await driveOp(c, ["stopped"], {runner_probe: {probeOutcome: "reachable"}});
        expect(seen.map((s) => s.type)).toEqual(["runner_probe"]);
        expect((await scopeEvents(c)).at(-1)).toMatchObject({from_state: "starting", to_state: "stopped", code: "runner_not_isolated"});
        expect((await w.journal(c.revisionId)).filter((j) => j.step === "up" && j.attempt >= 1).length).toBe(1); // only the creation's own up row
    });

    it("the app check fails (smoke_failed) ⇒ a cleanup stop is enqueued ⇒ stopped with the failure code", async () => {
        const c = await stopped();
        await startMirror(c.d, {mirrorId: c.mirrorId});
        const seen = await driveOp(c, ["stopped", "failed", "ready"], FAIL_SMOKE);
        expect(seen.map((s) => s.type)).toEqual(["runner_probe", "mirror_up", "mirror_check", "mirror_stop"]);
        expect(await status(c)).toBe("stopped");
        expect((await scopeEvents(c)).at(-1)).toMatchObject({from_state: "starting", to_state: "stopped", code: "smoke_failed"});
    });

    it("the cleanup stop fails too ⇒ failed (containers may still run), with the stop's code", async () => {
        const c = await stopped();
        await startMirror(c.d, {mirrorId: c.mirrorId});
        await driveOp(c, ["stopped", "failed", "ready"], {...FAIL_SMOKE, mirror_stop: {status: "failed", reason: "stop_incomplete"}});
        expect(await status(c)).toBe("failed");
        expect((await scopeEvents(c)).at(-1)).toMatchObject({to_state: "failed", code: "stop_incomplete"});
        expect((await w.mirrorRow(c.mirrorId)).active_revision_id).toBe(c.revisionId);
    });

    it("refusals: locked, flag off, member, foreign, a ready mirror, idempotent while starting", async () => {
        const c = await stopped();
        expect(await startMirror({...c.d, configAllowed: async () => false}, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "locked"});
        expect(await startMirror({...c.d, mirrorsEnabled: () => false}, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "mirrors_disabled"});
        expect(await startMirror({...c.d, principal: member}, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "forbidden"});
        expect(await startMirror({...c.d, principal: foreign}, {mirrorId: c.mirrorId})).toMatchObject({ok: false, code: "not_found"});
        expect(await status(c)).toBe("stopped");
        const ready = await make();
        expect(await startMirror(ready.d, {mirrorId: ready.mirrorId})).toMatchObject({ok: false, code: "mirror_state_invalid"});
        expect(await startMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true});
        expect(await startMirror(c.d, {mirrorId: c.mirrorId})).toEqual({ok: true});
        expect((await scopeEvents(c)).filter((e) => e.to_state === "starting").length).toBe(1);
    });

    it("D31: the requester demoted to member while the start runs ⇒ stopped reauth_failed, nothing was started", async () => {
        const c = await stopped();
        await startMirror(c.d, {mirrorId: c.mirrorId});
        const seen = await driveOp(c, ["stopped"], {}, {between: async (t) => { if (t === "runner_probe") w.principals.set(orgAdmin.userId, {userId: orgAdmin.userId, systemRole: "user", memberships: [{organizationId: w.org, role: "member"}]}); }});
        expect(seen.map((s) => s.type)).toEqual(["runner_probe"]);
        expect((await scopeEvents(c)).at(-1)).toMatchObject({to_state: "stopped", code: "reauth_failed"});
    });

    it("an operation over its budget with an unanswered probe ⇒ stopped run_timeout", async () => {
        const c = await stopped();
        await startMirror(c.d, {mirrorId: c.mirrorId});
        await tickAllMirrors(c.d); // probe enqueued, never answered
        w.advance(30 * 60_000 + 1);
        await tickAllMirrors(c.d);
        expect(await status(c)).toBe("stopped");
        expect((await scopeEvents(c)).at(-1)).toMatchObject({to_state: "stopped", code: "run_timeout"});
    });
});
