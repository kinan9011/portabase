import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {classifyEnvKey} from "@/fork/compose-compiler/rules";
import {loadMirrorEntryFacts, loadMirrorRunners, loadMirrorSource} from "@/fork/mirror/wizard-view";
import {createMirror} from "@/fork/mirror/service";
import {mirrorWorld, type MirrorWorld} from "@/fork/__tests__/w22a-world";
import {seedAgent} from "@/fork/__tests__/w04-helpers";

let w: MirrorWorld;
let sys: ForkPrincipal, orgAdmin: ForkPrincipal, member: ForkPrincipal;

beforeAll(async () => { w = await mirrorWorld(); sys = await w.user("sys"); orgAdmin = await w.user("admin"); member = await w.user("member"); w.flag.on = true; });
afterAll(async () => { await w?.close(); });
beforeEach(() => { w.reset(); });

const runners = (p: ForkPrincipal | null, now = new Date()) => loadMirrorRunners(w.t.db, p, w.org, {now, serverUrl: w.channelDeps(w.adminId).serverUrl()});
const find = async (id: string, p: ForkPrincipal | null = orgAdmin, now = new Date()) => (await runners(p, now)).find((r) => r.id === id);

describe("loadMirrorRunners", () => {
    it("an eligible, isolated runner with one probe target", async () => {
        const ru = await w.runner();
        const r = await find(ru.agentId);
        expect(r).toMatchObject({name: ru.name, eligible: true, ineligible: null, isolation: "isolated", isolationUnknown: null, reachableCount: 0, targetCount: 1, probePending: false, busy: false, mirrorsHeld: 0, freePorts: 1000});
        expect(r?.probedAt).not.toBeNull();
    });
    it("online status: an agent that pinged a few seconds ago is online, one that pinged 2 h ago offline (the `timestamp` column holds UTC wall time, read as UTC whatever the process time zone is)", async () => {
        const ru = await w.runner();
        await w.pool.query("update agents set last_contact = timezone('UTC', now()) where id=$1", [ru.agentId]);
        expect((await find(ru.agentId))?.status).toBe("online");
        await w.pool.query("update agents set last_contact = timezone('UTC', now()) - interval '2 hours' where id=$1", [ru.agentId]);
        expect((await find(ru.agentId))?.status).toBe("offline");
    });
    it("an agent that is not designated is absent", async () => {
        const id = await seedAgent(w.pool, w.org, "plain-agent");
        expect(await find(id)).toBeUndefined();
    });
    it("designated but without runner.v1 ⇒ not_attested, not eligible", async () => {
        const ru = await w.runner({caps: ["channel.v1"], targets: false});
        expect(await find(ru.agentId)).toMatchObject({eligible: false, ineligible: "not_attested"});
    });
    it("no probe targets ⇒ targetCount 0 and isolation never_probed", async () => {
        const ru = await w.runner({targets: false});
        expect(await find(ru.agentId)).toMatchObject({eligible: true, targetCount: 0, isolation: "unknown", isolationUnknown: "never_probed"});
    });
    it("a probe that reached a protected address ⇒ not_isolated with its count", async () => {
        const ru = await w.runner({isolated: false});
        await w.probeNow(ru, "reachable");
        expect(await find(ru.agentId)).toMatchObject({isolation: "not_isolated", reachableCount: 1});
    });
    it("a probe older than 24 h is stale (clock relative to the real now) and the runner shows offline", async () => {
        const ru = await w.runner();
        const later = new Date(Date.now() + 25 * 3600e3);
        expect(await find(ru.agentId, orgAdmin, later)).toMatchObject({isolation: "unknown", isolationUnknown: "stale", status: "offline"});
    });
    it("probePending while the requested probe task is not final", async () => {
        const ru = await w.runner({isolated: false});
        const {requestRunnerProbe} = await import("@/fork/runner/service");
        const p = await requestRunnerProbe({...w.channelDeps(w.adminId), mirrorsEnabled: () => true, resolve: w.resolve}, {agentId: ru.agentId});
        expect(p.ok).toBe(true);
        expect(await find(ru.agentId)).toMatchObject({probePending: true, isolation: "unknown", isolationUnknown: "probe_pending"});
        await w.runnerStep(ru, {runner_probe: {probeOutcome: "blocked"}});
        expect(await find(ru.agentId)).toMatchObject({probePending: false, isolation: "isolated"});
    });
    it("busy while a creation is active; held ports follow the wipe predicate", async () => {
        const stack = await w.world(false);
        await w.setSeq(stack);
        w.reset();
        const ru = await w.runner();
        const d = w.deps(orgAdmin, stack);
        const c = await createMirror(d, w.createReq(stack, ru));
        expect(c.ok).toBe(true);
        expect(await find(ru.agentId)).toMatchObject({busy: true, mirrorsHeld: 1, freePorts: 999});
        const done = await w.drive(d, ru, (c as {revisionId: string}).revisionId);
        expect(done.state).toBe("ready");
        expect(await find(ru.agentId)).toMatchObject({busy: false, mirrorsHeld: 1, freePorts: 999}); // a READY mirror keeps its port
    });
    it("a runner of another organization and a member principal see nothing; org admin and system admin see it", async () => {
        const ru = await w.runner();
        const foreign = await seedAgent(w.pool, w.otherOrg, "foreign-runner");
        await w.pool.query("insert into fork_runner (agent_id, designated_by, designated_at, updated_at) values ($1,$2,now(),now())", [foreign, w.adminId]);
        expect(await find(foreign)).toBeUndefined();
        expect(await find(ru.agentId, member)).toBeUndefined();
        expect(await runners(null)).toEqual([]);
        expect(await find(ru.agentId, sys)).toBeDefined();
        expect(await find(ru.agentId, orgAdmin)).toBeDefined();
    });
    it("a runner whose agent also belongs to another organization is hidden (foreign_org)", async () => {
        const ru = await w.runner();
        await w.pool.query("insert into organization_agents (agent_id, organization_id) values ($1,$2)", [ru.agentId, w.otherOrg]);
        expect(await find(ru.agentId)).toBeUndefined();
        await w.pool.query("delete from organization_agents where agent_id=$1", [ru.agentId]);
    });
});

describe("loadMirrorSource", () => {
    it("services, ports and env KEY NAMES of the pinned inventory, with the compiler's recommended class", async () => {
        const stack = await w.world(null);
        const s = await loadMirrorSource(w.t.db, w.org, stack.stack, stack.rp);
        expect(s).not.toBeNull();
        expect(s!.privacy).toEqual({containsPersonalData: null, optIn: false});
        expect(s!.services.length).toBeGreaterThan(0);
        for (const svc of s!.services) for (const e of svc.env) expect(e.recommended).toBe(classifyEnvKey(e.key));
    });
    it("a recovery point of another stack, an unknown id, or another organization ⇒ null", async () => {
        const a = await w.world(false);
        w.reset();
        const b = await w.world(false);
        expect(await loadMirrorSource(w.t.db, w.org, a.stack, b.rp)).toBeNull();
        expect(await loadMirrorSource(w.t.db, w.org, a.stack, randomUUID())).toBeNull();
        expect(await loadMirrorSource(w.t.db, w.otherOrg, a.stack, a.rp)).toBeNull();
    });
    it("canary: no value, path, URL or IP address reaches the DTOs", async () => {
        const stack = await w.world(false);
        w.reset();
        const ru = await w.runner();
        const dto = JSON.stringify({src: await loadMirrorSource(w.t.db, w.org, stack.stack, stack.rp), runners: await runners(orgAdmin), entry: await loadMirrorEntryFacts(w.t.db, orgAdmin, w.org, stack.stack)});
        expect(dto).toContain(ru.agentId);
        expect(dto).not.toMatch(/\/srv\/|https?:|10\.20\.30|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
        expect(dto).not.toMatch(/credential|password.*=|secret/i);
    });
});

describe("loadMirrorEntryFacts", () => {
    it("counts verified recovery points of THIS stack and eligible runners visible to the principal", async () => {
        const stack = await w.world(false);
        w.reset();
        await w.runner();
        const f = await loadMirrorEntryFacts(w.t.db, orgAdmin, w.org, stack.stack);
        expect(f.verifiedCount).toBe(1);
        expect(f.runnerCount).toBeGreaterThanOrEqual(1);
        expect(await loadMirrorEntryFacts(w.t.db, orgAdmin, w.otherOrg, stack.stack)).toMatchObject({verifiedCount: 0});
        expect((await loadMirrorEntryFacts(w.t.db, member, w.org, stack.stack)).runnerCount).toBe(0);
        await w.pool.query("update fork_recovery_point set status='pending_verification', verified_at=null where id=$1", [stack.rp]);
        expect((await loadMirrorEntryFacts(w.t.db, orgAdmin, w.org, stack.stack)).verifiedCount).toBe(0);
    });
});
