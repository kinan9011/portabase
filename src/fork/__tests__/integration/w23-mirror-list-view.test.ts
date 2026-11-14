import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {createMirror} from "@/fork/mirror/service";
import {loadMirrorDetailExtras, loadMirrorList, loadMirrorLog, MirrorDetailExtras, MirrorListRow, MirrorLogEntry} from "@/fork/mirror/list-view";
import {mirrorWorld, type MirrorWorld} from "@/fork/__tests__/w22a-world";

let w: MirrorWorld;
let orgAdmin: ForkPrincipal;
beforeAll(async () => { w = await mirrorWorld(); orgAdmin = await w.user("admin"); });
afterAll(async () => { await w?.close(); });
beforeEach(() => { w.reset(); w.flag.on = true; });

type Ready = {mirrorId: string; revisionId: string; name: string};
/** Create a mirror and drive it to READY with the simulated runner. */
async function ready(): Promise<Ready & {stack: Awaited<ReturnType<MirrorWorld["world"]>>; ru: Awaited<ReturnType<MirrorWorld["runner"]>>}> {
    const stack = await w.world(false);
    await w.setSeq(stack);
    const ru = await w.runner();
    const d = w.deps(orgAdmin, stack);
    const req = w.createReq(stack, ru);
    const r = await createMirror(d, req);
    if (!r.ok) throw new Error(`create refused: ${r.code}`);
    const done = await w.drive(d, ru, r.revisionId);
    if (done.state !== "ready") throw new Error(`not ready: ${done.state} ${done.reason}`);
    return {mirrorId: r.mirrorId, revisionId: r.revisionId, name: req.name, stack, ru};
}
const rowOf = async (id: string) => (await loadMirrorList(w.t.db, w.org)).find((r) => r.id === id)!;
const extras = (mirrorId: string, o: Partial<{now: Date; canManage: boolean}> = {}) => loadMirrorDetailExtras(w.t.db, mirrorId, {now: o.now ?? new Date(), serverUrl: w.channelDeps(w.adminId).serverUrl(), canManage: o.canManage ?? true});

describe("loadMirrorList", () => {
    it("org-scoped, deleted hidden, healthy from seeded services, RP date joined, active revision shown", async () => {
        const a = await ready();
        const b = await ready();
        const foreign = await ready();
        const gone = await ready();
        await w.q("update fork_mirror set organization_id=$2 where id=$1", [foreign.mirrorId, w.otherOrg]);
        await w.q("update fork_mirror set deleted_at=now(), status='deleted' where id=$1", [gone.mirrorId]);
        const list = await loadMirrorList(w.t.db, w.org);
        const ids = list.map((r) => r.id);
        expect(ids).toEqual(expect.arrayContaining([a.mirrorId, b.mirrorId]));
        expect(ids).not.toContain(foreign.mirrorId);
        expect(ids).not.toContain(gone.mirrorId);
        const row = list.find((r) => r.id === a.mirrorId)!;
        expect(MirrorListRow.safeParse(row).success).toBe(true);
        expect(row).toMatchObject({name: a.name, status: "ready", health: "healthy", activeSeq: 1, alert: false, latest: {seq: 1, state: "ready", reason: null}});
        expect(row.rpSequence).not.toBeNull();
        expect(row.rpCreatedAt).not.toBeNull();
        expect(row.hostPort).toBeGreaterThanOrEqual(41000);
        expect(row.checkedAt).not.toBeNull();
        expect(row.stack.id).toBe(a.stack.stack);
        const names = list.map((r) => r.name);
        expect(names).toEqual([...names].sort()); // ordered by name
    });

    it("health branches follow the services of the active revision (degraded) and the mirror status (stopped-like / failed / pending)", async () => {
        const m = await ready();
        await w.q("update fork_mirror_revision set services=$2::jsonb where id=$1", [m.revisionId, JSON.stringify([{service: "web", state: "exited", health: null}])]);
        expect(await rowOf(m.mirrorId)).toMatchObject({health: "degraded"});
        await w.q("update fork_mirror set status='deleting' where id=$1", [m.mirrorId]);
        expect(await rowOf(m.mirrorId)).toMatchObject({health: "pending", status: "deleting"});
    });

    it("a newer failed revision next to an older active one raises the alert; latest differs from active", async () => {
        const m = await ready();
        await w.pool.query(`create temp table w23_rev as select * from fork_mirror_revision where id=$1::uuid`, [m.revisionId]);
        await w.pool.query(`update w23_rev set id=$1::uuid, seq=2, state='failed', reason='smoke_failed', host_port=41100, wipe_state='verified', readied_at=null`, [randomUUID()]);
        await w.pool.query(`insert into fork_mirror_revision select * from w23_rev`);
        await w.pool.query(`drop table w23_rev`);
        const row = await rowOf(m.mirrorId);
        expect(row).toMatchObject({alert: true, activeSeq: 1, latest: {seq: 2, state: "failed", reason: "smoke_failed"}, status: "ready"});
    });
});

describe("loadMirrorDetailExtras", () => {
    it("config + counts; env key names only for managers; facet = newest ready revision of the stack; RP date map", async () => {
        const m = await ready();
        await w.q("update fork_mirror set policy = jsonb_set(policy, '{env}', $2::jsonb) where id=$1", [m.mirrorId, JSON.stringify({web: {SMTP_URL: "disable", API_KEY: "keep_exact"}})]);
        const mgr = await extras(m.mirrorId, {canManage: true});
        expect(MirrorDetailExtras.safeParse(mgr).success).toBe(true);
        expect(mgr.config.overrides).toEqual(expect.arrayContaining([{service: "web", key: "SMTP_URL", action: "disable"}, {service: "web", key: "API_KEY", action: "keep_exact"}]));
        expect(mgr.config).toMatchObject({overrideCount: 2, keptCount: 1, access: {service: "web", target: 8080}, httpPath: "/"});
        const mem = await extras(m.mirrorId, {canManage: false});
        expect(mem.config.overrides).toBeNull();
        expect(mem.config).toMatchObject({overrideCount: 2, keptCount: 1});
        expect(JSON.stringify(mem)).not.toContain("SMTP_URL");
        expect(mem.facet).not.toBeNull();
        expect(Object.keys(mem.rpDates).length).toBe(1);
        expect(mem.runnerIsolation.state).toBe("isolated");
    });

    it("a runner isolation probe older than 24 h reads as unknown (clock relative to the real now)", async () => {
        const m = await ready();
        const later = new Date(Date.now() + 25 * 3600e3);
        expect((await extras(m.mirrorId, {now: later})).runnerIsolation).toMatchObject({state: "unknown", reason: "stale"});
    });

    it("a removed runner ⇒ unknown / runner_removed", async () => {
        const m = await ready();
        await w.q("update fork_mirror set runner_agent_id=null where id=$1", [m.mirrorId]);
        expect((await extras(m.mirrorId)).runnerIsolation).toEqual({state: "unknown", probedAt: null, reason: "runner_removed"});
    });
});

describe("loadMirrorLog", () => {
    it("merges events and journal rows newest first; a failed task carries only its code", async () => {
        const m = await ready();
        const [j] = await w.q("select task_id from fork_mirror_task where revision_id=$1 and step='check' limit 1", [m.revisionId]);
        await w.q("update fork_agent_task set status='failed', result=$2::jsonb where id=$1", [j!.task_id, JSON.stringify({reason: "smoke_failed"})]);
        const log = await loadMirrorLog(w.t.db, m.mirrorId);
        expect(log.every((e) => MirrorLogEntry.safeParse(e).success)).toBe(true);
        expect(log.some((e) => e.kind === "event" && e.title === "Mirror ready")).toBe(true);
        expect(log.some((e) => e.kind === "task" && e.title === "Health checks" && e.status === "failed" && e.code === "smoke_failed")).toBe(true);
        const sorted = [...log].sort((a, b) => (a.at < b.at ? 1 : -1));
        expect(log.map((e) => e.at)).toEqual(sorted.map((e) => e.at));
    });

    it("CANARY: nothing planted in a task result, an event's details or an unknown policy key reaches any DTO", async () => {
        const m = await ready();
        const canary = `W23CANARY-${randomUUID()}`;
        const [j] = await w.q("select task_id from fork_mirror_task where revision_id=$1 and step='up' limit 1", [m.revisionId]);
        await w.q("update fork_agent_task set result=$2::jsonb where id=$1", [j!.task_id, JSON.stringify({reason: "execution_error", secret: canary, path: "/srv/portabase-mirrors/x", url: `http://10.1.2.3/${canary}`})]);
        await w.q("update fork_mirror_event set details=$2::jsonb where mirror_id=$1", [m.mirrorId, JSON.stringify({canary, path: "/srv/portabase-mirrors/y"})]);
        await w.q("update fork_mirror set policy = policy || $2::jsonb where id=$1", [m.mirrorId, JSON.stringify({zz_unknown: canary})]);
        const all = JSON.stringify([await loadMirrorList(w.t.db, w.org), await extras(m.mirrorId), await loadMirrorLog(w.t.db, m.mirrorId)]);
        expect(all).not.toContain("W23CANARY");
        expect(all).not.toContain("/srv/");
        expect(all).not.toMatch(/https?:/);
        expect(all).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    });
});
