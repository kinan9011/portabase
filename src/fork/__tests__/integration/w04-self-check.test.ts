import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import {assertForkConfigAllowed, currentForkMode, ForkLockedError, invalidateForkModeCache, registerActivePolicyProbe, registerSelfCheck, resetForkState, setLaneStatus} from "@/fork/mode";
import {clearForkRuntimeTasks, registerForkRuntimeTask, startForkRuntime} from "@/fork/runtime";
import {countActivePolicies, evaluateSelfCheck, forkBannerText, registerRealChecks} from "@/fork/self-check";
import {verifyAuditChain} from "@/fork/audit";
import {createTestDb, applyUpstreamMigrations} from "@/fork/__tests__/db-helpers";
import {freshForkDb, seedAgent, seedArtifact, seedChannel, seedConnection, seedEnvironment, seedOrg, seedRp, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {drizzle} from "drizzle-orm/node-postgres";
import type {ForkDb} from "@/fork/db/handle";

const OK_ENV = {AUTH_SIGNUP_ENABLED: "false"};
let w: W04Db;
beforeAll(async () => { w = await freshForkDb(); });
afterAll(async () => { await w.drop(); });
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);
const reset = async () => {
    await q("delete from fork_stack_policy"); await q("delete from fork_recovery_point_artifact"); await q("delete from fork_recovery_point");
    await q("delete from fork_stack"); await q("delete from fork_arcane_connection");
    await q("delete from organization_agents"); await q("delete from organization_storage_channels");
    await q("delete from storage_channel"); await q("delete from agents"); await q("delete from organization");
};

describe("E4 D21 self-check matrix (real Postgres, real queries)", () => {
    let org: string;
    beforeEach(async () => { await reset(); org = await seedOrg(w.pool, "ACME-CANARY-ORG"); });

    it("healthy: one org, signup disabled ⇒ ok", async () => expect(await evaluateSelfCheck(w.db, OK_ENV)).toEqual({ok: true, warnings: undefined}));

    it("C1 org-count: 0 orgs, 2 orgs ⇒ red; a SOFT-DELETED second org does not count", async () => {
        const second = await seedOrg(w.pool, "second");
        expect(await evaluateSelfCheck(w.db, OK_ENV)).toMatchObject({ok: false, failed: "org-count"});
        await q("update organization set deleted_at = now() where id=$1", [second]);
        expect((await evaluateSelfCheck(w.db, OK_ENV)).ok).toBe(true);
        await q("update organization set deleted_at = now() where id=$1", [org]);
        expect(await evaluateSelfCheck(w.db, OK_ENV)).toMatchObject({ok: false, failed: "org-count"});
    });

    it("C1 covers the UI-action path: createOrganizationAction has no fork/flag guard and writes a second `organization` row ⇒ next evaluation is red", async () => {
        // The action (src/features/organizations/actions/organization.action.ts) is a plain `userAction` → better-auth org plugin → INSERT into organization.
        const src = (await import("node:fs")).readFileSync("src/features/organizations/actions/organization.action.ts", "utf8");
        const body = src.slice(src.indexOf("createOrganizationAction"), src.indexOf("createOrganizationAction") + 1500);
        expect(body).not.toMatch(/canCreateOwnOrganization|AUTH_SIGNUP|computeSystemPermissions|FORK/); // nothing can prevent it ⇒ detective model (ADR-011)
        await q("insert into organization (name, slug) values ('created via UI action', 'ui-action-org')"); // its DB effect
        expect(await evaluateSelfCheck(w.db, OK_ENV)).toMatchObject({ok: false, failed: "org-count"});
    });

    it("C2 signup-open: unset (upstream default true) and `true` ⇒ red; `false` ⇒ ok", async () => {
        expect(await evaluateSelfCheck(w.db, {})).toMatchObject({ok: false, failed: "signup-open"});
        expect(await evaluateSelfCheck(w.db, {AUTH_SIGNUP_ENABLED: "true"})).toMatchObject({ok: false, failed: "signup-open"});
        expect((await evaluateSelfCheck(w.db, {AUTH_SIGNUP_ENABLED: "false"})).ok).toBe(true);
    });

    it("combined failures list every code, exactly", async () => {
        await seedOrg(w.pool);
        expect(await evaluateSelfCheck(w.db, {AUTH_SIGNUP_ENABLED: "true"})).toMatchObject({ok: false, failed: "org-count,signup-open"});
    });

    it("C3 agent-foreign-org: org-less ok; own-org ok; foreign via COLUMN red; foreign via organization_agents red; unreferenced foreign agent ignored", async () => {
        const other = await seedOrg(w.pool, "other-org");
        const conn = await seedConnection(w.pool, org);
        await q("update organization set deleted_at=now() where id=$1", [other]); // keep exactly one live org for C1
        const link = async (agent: string | null) => { await q("delete from fork_arcane_environment"); await seedEnvironment(w.pool, conn, agent, "n", String(Math.random())); };

        await link(await seedAgent(w.pool, null)); // org-less (system agent) ⇒ allowed
        expect((await evaluateSelfCheck(w.db, OK_ENV)).ok).toBe(true);
        await link(await seedAgent(w.pool, org));
        expect((await evaluateSelfCheck(w.db, OK_ENV)).ok).toBe(true);
        await seedAgent(w.pool, other); // foreign but NOT referenced by any fork row
        expect((await evaluateSelfCheck(w.db, OK_ENV)).ok).toBe(true);
        await link(await seedAgent(w.pool, other)); // referenced, foreign column
        expect(await evaluateSelfCheck(w.db, OK_ENV)).toMatchObject({ok: false, failed: "agent-foreign-org"});
        const viaTable = await seedAgent(w.pool, null); // org-less column, but m:n row to a foreign org
        await q("insert into organization_agents (organization_id, agent_id) values ($1,$2)", [other, viaTable]);
        await link(viaTable);
        expect(await evaluateSelfCheck(w.db, OK_ENV)).toMatchObject({ok: false, failed: "agent-foreign-org"});
    });

    it("C4 also covers the channels of a stack POLICY (W10: fork_stack_policy.storage_channel_ids)", async () => {
        await q("delete from fork_recovery_point_artifact");
        await q("delete from fork_stack_policy");
        const other = await seedOrg(w.pool, "pol-other");
        await q("update organization set deleted_at=now() where id=$1", [other]);
        const stack = await seedStack(w.pool, org, null, "s4pol");
        const own = await seedChannel(w.pool, org); const foreign = await seedChannel(w.pool, other);
        await q("insert into fork_stack_policy (stack_id, storage_channel_ids) values ($1, $2)", [stack, [own]]);
        expect((await evaluateSelfCheck(w.db, OK_ENV)).ok).toBe(true);
        await q("update fork_stack_policy set storage_channel_ids = $2 where stack_id=$1", [stack, [own, foreign]]);
        expect(await evaluateSelfCheck(w.db, OK_ENV)).toMatchObject({ok: false, failed: "storage-foreign-org"});
        await q("delete from fork_stack_policy");
    });

    it("C4 storage-foreign-org: same matrix for channels referenced by RP artifacts (column and m:n)", async () => {
        const other = await seedOrg(w.pool, "other-org");
        await q("update organization set deleted_at=now() where id=$1", [other]);
        const stack = await seedStack(w.pool, org, null, "s4");
        const rp = await seedRp(w.pool, stack, {status: "incomplete"});
        const use = async (ch: string) => { await q("delete from fork_recovery_point_artifact"); await seedArtifact(w.pool, rp, {channelId: ch}); };

        await use(await seedChannel(w.pool, null));
        expect((await evaluateSelfCheck(w.db, OK_ENV)).ok).toBe(true);
        await use(await seedChannel(w.pool, org));
        expect((await evaluateSelfCheck(w.db, OK_ENV)).ok).toBe(true);
        await seedChannel(w.pool, other); // foreign, unreferenced
        expect((await evaluateSelfCheck(w.db, OK_ENV)).ok).toBe(true);
        await use(await seedChannel(w.pool, other));
        expect(await evaluateSelfCheck(w.db, OK_ENV)).toMatchObject({ok: false, failed: "storage-foreign-org"});
        const viaTable = await seedChannel(w.pool, null);
        await q("insert into organization_storage_channels (organization_id, storage_channel_id) values ($1,$2)", [other, viaTable]);
        await use(viaTable);
        expect(await evaluateSelfCheck(w.db, OK_ENV)).toMatchObject({ok: false, failed: "storage-foreign-org"});
    });

    it("C5 mcp-enabled is advisory: warning only, never red", async () => {
        expect(await evaluateSelfCheck(w.db, {...OK_ENV, MCP_ENABLED: "true"})).toEqual({ok: true, warnings: ["mcp-enabled"]});
    });

    it("DB error ⇒ fail closed `check-error`, never throws, nothing leaks", async () => {
        const broken = {execute: async () => { throw new Error("connection to 10.0.0.5 refused password=hunter2"); }} as unknown as ForkDb;
        const r = await evaluateSelfCheck(broken, OK_ENV);
        expect(r).toEqual({ok: false, failed: "check-error"});
    });

    it("red results never contain org / agent / channel names or ids (canary)", async () => {
        await seedOrg(w.pool, "SECOND-CANARY-ORG");
        const r = await evaluateSelfCheck(w.db, {AUTH_SIGNUP_ENABLED: "true"});
        const text = JSON.stringify(r) + forkBannerText({mode: "locked", lockReason: "self-check-failed", detail: r.failed});
        expect(text).not.toMatch(/CANARY|[0-9a-f]{8}-[0-9a-f]{4}/i);
    });
});

describe("real active-policy probe", () => {
    it("lane never ran (no fork tables) ⇒ 0, so flags-off parity survives; with rows counts activated & not deactivated only", async () => {
        const t = await createTestDb();
        try {
            await applyUpstreamMigrations(t.pool);
            expect(await countActivePolicies(drizzle({client: t.pool}) as unknown as ForkDb)).toBe(0);
        } finally { await t.drop(); }

        await reset();
        const org = await seedOrg(w.pool);
        const s = [await seedStack(w.pool, org, null, "p1"), await seedStack(w.pool, org, null, "p2"), await seedStack(w.pool, org, null, "p3")];
        await q("insert into fork_stack_policy (stack_id) values ($1)", [s[0]]); // configured, not activated
        await q("insert into fork_stack_policy (stack_id, activated_at) values ($1, now())", [s[1]]);
        await q("insert into fork_stack_policy (stack_id, activated_at, deactivated_at) values ($1, now(), now())", [s[2]]);
        expect(await countActivePolicies(w.db)).toBe(1);
    });
});

describe("E4 degraded mode with the REAL probe + REAL self-check + REAL rows (W01 carry-in)", () => {
    const env = {FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false"};
    let org: string;
    let base = 0; // fork_audit_event is append-only: tests compare only the events written after this seq
    const events = async () => (await q("select action, result, redacted_details d from fork_audit_event where seq > $1 order by seq", [base])).rows;
    const mode = async (e: Record<string, string | undefined> = env) => { invalidateForkModeCache(); return currentForkMode({env: e}); };
    beforeEach(async () => {
        resetForkState(); clearForkRuntimeTasks();
        await reset();
        await q("delete from fork_notification_outbox"); await q("delete from fork_meta where key='selfcheck.state'");
        base = Number((await q("select coalesce(max(seq),0) m from fork_audit_event")).rows[0].m);
        org = await seedOrg(w.pool, "ACME-CANARY-ORG");
        setLaneStatus({state: "applied"});
        await registerRealChecks({registerActivePolicyProbe, registerSelfCheck}, {db: w.db, env: {AUTH_SIGNUP_ENABLED: process.env.__W04_SIGNUP ?? "false"}});
    });
    afterEach(() => { delete process.env.__W04_SIGNUP; resetForkState(); clearForkRuntimeTasks(); });

    const activate = async () => {
        const stack = await seedStack(w.pool, org, null, "act");
        await q("insert into fork_stack_policy (stack_id, activated_at) values ($1, now())", [stack]);
    };

    it("healthy ⇒ on; the transition table stays silent (no audit/notification for a healthy first evaluation)", async () => {
        expect((await mode()).mode).toBe("on");
        expect(await events()).toEqual([]);
    });

    it("a second organization + an activated policy ⇒ LOCKED (real rows): config denied, runtime plane still runs, ONE audit + ONE notification, no names", async () => {
        await activate();
        expect((await mode()).mode).toBe("on");
        await seedOrg(w.pool, "SECOND-CANARY-ORG");
        const m = await mode();
        expect(m).toMatchObject({mode: "locked", lockReason: "self-check-failed", detail: "org-count"});
        for (let i = 0; i < 4; i++) await mode(); // repeated evaluations while red: de-duplicated
        await expect(assertForkConfigAllowed({env})).rejects.toBeInstanceOf(ForkLockedError);

        const ran: string[] = [];
        registerForkRuntimeTask({name: "scheduler", plane: "runtime", start: () => { ran.push("scheduler"); }});
        registerForkRuntimeTask({name: "audit-retention", plane: "runtime", start: () => { ran.push("retention"); }});
        registerForkRuntimeTask({name: "discovery", plane: "config", start: () => { ran.push("discovery"); }});
        expect((await startForkRuntime("locked")).started).toEqual(["scheduler", "audit-retention"]);
        expect(ran).toEqual(["scheduler", "retention"]); // discovery (config plane) did NOT start

        const audit = await events();
        expect(audit).toEqual([{action: "fork.selfcheck.failed", result: "failure", d: {codes: ["org-count"]}}]);
        const outbox = (await q("select kind, state, payload from fork_notification_outbox")).rows;
        expect(outbox).toEqual([{kind: "fork.selfcheck.failed", state: "pending", payload: {codes: ["org-count"]}}]);
        expect(JSON.stringify([audit, outbox, forkBannerText(m)])).not.toMatch(/CANARY/);
        expect(forkBannerText(m)).toMatch(/^Fork configuration locked: /);
        expect((await verifyAuditChain(w.db)).ok).toBe(true);
    });

    it("recovery: removing the extra org ⇒ on again, ONE `recovered` audit + notification", async () => {
        await activate();
        const extra = await seedOrg(w.pool, "extra");
        expect((await mode()).mode).toBe("locked");
        await q("update organization set deleted_at = now() where id=$1", [extra]);
        expect((await mode()).mode).toBe("on");
        await mode();
        expect((await events()).map((r) => r.action)).toEqual(["fork.selfcheck.failed", "fork.selfcheck.recovered"]);
        expect((await q("select kind from fork_notification_outbox order by created_at")).rows.length).toBe(2);
        await expect(assertForkConfigAllowed({env})).resolves.toBeUndefined();
    });

    it("R1-gate shape: AUTH_SIGNUP_ENABLED=true on a running instance ⇒ locked, schedule (runtime plane) keeps running, notification recorded", async () => {
        await activate();
        await registerRealChecks({registerActivePolicyProbe, registerSelfCheck}, {db: w.db, env: {AUTH_SIGNUP_ENABLED: "true"}});
        const m = await mode();
        expect(m).toMatchObject({mode: "locked", detail: "signup-open"});
        const ran = vi.fn();
        registerForkRuntimeTask({name: "scheduler", plane: "runtime", start: ran});
        await startForkRuntime(m.mode);
        expect(ran).toHaveBeenCalledOnce();
        expect((await q("select count(*)::int c from fork_notification_outbox")).rows[0].c).toBe(1);
        expect(forkBannerText(m)).toContain("AUTH_SIGNUP_ENABLED");
    });

    it("failed self-check with NO activated policy ⇒ off (fork invisible), but still audited once", async () => {
        await seedOrg(w.pool, "extra");
        expect((await mode()).mode).toBe("off");
        expect((await events()).map((r) => r.action)).toEqual(["fork.selfcheck.failed"]);
    });

    it("probe failure (table present but unreadable) is conservative: with flags off the fork is `locked`, never `off`; healthy flags stay `on`", async () => {
        await q("alter table fork_stack_policy rename column activated_at to activated_at_x");
        try {
            expect((await mode({})).mode).toBe("locked"); // flags off + unknown activation ⇒ assume something may be scheduled
            expect((await mode()).mode).toBe("on");
        } finally { await q("alter table fork_stack_policy rename column activated_at_x to activated_at"); }
    });
});
