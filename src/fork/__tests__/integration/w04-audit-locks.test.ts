import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {hashAuditEvent, purgeAuditEvents, recordAudit, verifyAuditChain} from "@/fork/audit";
import {acquireLease, releaseLease, tryWithForkLock, withForkLock} from "@/fork/locks";
import {touchScheduleState} from "@/fork/schedule-state";
import {freshForkDb, seedOrg, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";

const CANARY = "canary-SECRET-audit-7c1d";
let w: W04Db;
beforeAll(async () => { w = await freshForkDb(); });
afterAll(async () => { await w.drop(); });
const q = (s: string, p: unknown[] = []) => w.pool.query(s, p);

describe("E9 SEC-07 audit: append-only, hash-chained, redacted, retention", () => {
    it("records events; the chain verifies; seq is gapless", async () => {
        for (let i = 0; i < 5; i++) await recordAudit(w.db, {actorUserId: "u1", action: "fork.test.event", resourceType: "stack", resourceId: `r${i}`, result: "success", details: {i}});
        expect(await verifyAuditChain(w.db)).toEqual({ok: true, checked: 5});
        expect((await q("select min(seq) a, max(seq) b, count(*)::int c from fork_audit_event")).rows[0]).toEqual({a: "1", b: "5", c: 5});
    });

    it("concurrent writers cannot fork or gap the chain (advisory lock)", async () => {
        await Promise.all(Array.from({length: 25}, (_, i) => recordAudit(w.db, {action: "fork.test.parallel", result: "success", details: {i}})));
        const r = await verifyAuditChain(w.db);
        expect(r).toMatchObject({ok: true});
        expect(r.checked).toBe(30);
    });

    it("canary secrets in details never reach the table (checked on the raw row)", async () => {
        await recordAudit(w.db, {action: "fork.test.canary", result: "failure", details: {apiKey: CANARY, url: `https://u:${CANARY}@h/x?token=${CANARY}`, env: {A: CANARY}, nested: [{password: CANARY}], err: new Error(CANARY)}});
        const rows = (await q("select to_jsonb(e)::text t from fork_audit_event e")).rows.map((r) => r.t).join("\n");
        expect(rows).not.toContain(CANARY);
    });

    it("no UPDATE, DELETE or TRUNCATE outside the retention transaction (DB trigger)", async () => {
        await expect(q("update fork_audit_event set action='x' where seq=1")).rejects.toThrow(/append-only \(UPDATE\)/);
        await expect(q("delete from fork_audit_event where seq=1")).rejects.toThrow(/append-only \(DELETE\)/);
        await expect(q("truncate fork_audit_event")).rejects.toThrow(/append-only \(TRUNCATE\)/);
        await expect(q("select set_config('fork.audit_retention','on',false)").then(() => q("update fork_audit_event set action='x' where seq=1"))).rejects.toThrow(/append-only/); // the flag only unlocks DELETE
    });

    it("tampering that bypasses the trigger is DETECTED by verifyAuditChain (edit, removal, reorder)", async () => {
        await q("alter table fork_audit_event disable trigger fork_audit_event_append_only");
        try {
            await q("update fork_audit_event set result='failure' where seq=2");
            expect(await verifyAuditChain(w.db)).toMatchObject({ok: false, badSeq: 2, reason: "hash-mismatch"});
            await q("update fork_audit_event set result='success' where seq=2");
            expect((await verifyAuditChain(w.db)).ok).toBe(true);

            const saved = (await q("select * from fork_audit_event where seq=3")).rows[0];
            await q("delete from fork_audit_event where seq=3");
            expect(await verifyAuditChain(w.db)).toMatchObject({ok: false, badSeq: 4, reason: "gap"});
            await q("insert into fork_audit_event (seq,id,organization_id,actor_user_id,actor_kind,action,resource_type,resource_id,result,redacted_details,prev_hash,event_hash,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
                [saved.seq, saved.id, saved.organization_id, saved.actor_user_id, saved.actor_kind, saved.action, saved.resource_type, saved.resource_id, saved.result, saved.redacted_details, saved.prev_hash, saved.event_hash, saved.created_at]);
            expect((await verifyAuditChain(w.db)).ok).toBe(true);
        } finally {
            await q("alter table fork_audit_event enable trigger fork_audit_event_append_only");
        }
    });

    it("hashAuditEvent is deterministic and covers every field", () => {
        const base = {seq: 1, id: "i", organizationId: null, actorUserId: null, actorKind: "system", action: "a.b", resourceType: null, resourceId: null, result: "success", redactedDetails: {}, createdAt: new Date(0), prevHash: "0".repeat(64)};
        const h = hashAuditEvent(base);
        expect(hashAuditEvent({...base})).toBe(h);
        for (const patch of [{seq: 2}, {action: "a.c"}, {result: "failure"}, {redactedDetails: {x: 1}}, {prevHash: "1".repeat(64)}, {createdAt: new Date(1)}, {resourceId: "x"}, {actorUserId: "u"}])
            expect(hashAuditEvent({...base, ...patch})).not.toBe(h);
    });

    it("rejects malformed action codes (no free text as an action)", async () => {
        await expect(recordAudit(w.db, {action: "Drop Table; --", result: "success"})).rejects.toThrow(/invalid audit action/);
    });

    it("retention: purges only the old prefix, floor 90 d, keeps the chain valid and records the purge", async () => {
        const w2 = await freshForkDb();
        try {
            const day = 86_400_000;
            const now = new Date("2026-11-06T12:00:00Z");
            for (let i = 0; i < 4; i++) await recordAudit(w2.db, {action: "fork.test.old", result: "success", now: new Date(now.getTime() - (500 - i) * day)});
            for (let i = 0; i < 3; i++) await recordAudit(w2.db, {action: "fork.test.new", result: "success", now: new Date(now.getTime() - (10 - i) * day)});
            // a 1-day request is raised to the 90-day floor: nothing recent is purged
            const r = await purgeAuditEvents(w2.db, {now, retentionDays: 1});
            expect(r.purged).toBe(4);
            const left = (await w2.pool.query("select seq, action from fork_audit_event order by seq")).rows;
            expect(left.map((x) => x.action)).toEqual(["fork.test.new", "fork.test.new", "fork.test.new", "fork.audit.purged"]);
            expect(await verifyAuditChain(w2.db)).toMatchObject({ok: true, checked: 4});
            expect((await w2.pool.query("select redacted_details d from fork_audit_event where action='fork.audit.purged'")).rows[0].d).toMatchObject({purged: 4, retentionDays: 90});
            expect((await purgeAuditEvents(w2.db, {now, retentionDays: 400})).purged).toBe(0);
            // never purges everything: the newest row stays as the anchor
            expect((await purgeAuditEvents(w2.db, {now: new Date(now.getTime() + 1000 * day), retentionDays: 90})).purged).toBe(3);
            expect((await verifyAuditChain(w2.db)).ok).toBe(true);
        } finally { await w2.drop(); }
    });
});

describe("E10 ARCH-10 locks + schedule-state", () => {
    it("withForkLock serialises the critical section across concurrent transactions", async () => {
        const order: string[] = [];
        const job = (name: string) => withForkLock(w.db, "k1", async () => { order.push(`${name}:in`); await new Promise((r) => setTimeout(r, 60)); order.push(`${name}:out`); });
        await Promise.all([job("a"), job("b"), job("c")]);
        for (let i = 0; i < order.length; i += 2) expect(order[i].split(":")[0]).toBe(order[i + 1].split(":")[0]); // never interleaved
    });
    it("tryWithForkLock: second caller sees acquired:false while the first holds the key; different keys do not block", async () => {
        const inner = vi.fn();
        let release!: () => void;
        const holder = withForkLock(w.db, "k2", () => new Promise<void>((r) => { release = r; }));
        await new Promise((r) => setTimeout(r, 80));
        expect(await tryWithForkLock(w.db, "k2", async () => inner())).toEqual({acquired: false});
        expect(await tryWithForkLock(w.db, "k3", async () => 7)).toEqual({acquired: true, value: 7});
        release(); await holder;
        expect(inner).not.toHaveBeenCalled();
        expect(await tryWithForkLock(w.db, "k2", async () => 1)).toEqual({acquired: true, value: 1});
    });
    it("leases: owner-exclusive, renewable by the owner, stolen only after expiry, released only by the owner", async () => {
        const t0 = new Date("2026-01-01T00:00:00Z");
        expect(await acquireLease(w.db, "stack:1:run", "A", 60_000, t0)).toBe(true);
        expect(await acquireLease(w.db, "stack:1:run", "B", 60_000, new Date(t0.getTime() + 30_000))).toBe(false);
        expect(await acquireLease(w.db, "stack:1:run", "A", 60_000, new Date(t0.getTime() + 30_000))).toBe(true); // renew
        expect(await acquireLease(w.db, "stack:1:run", "B", 60_000, new Date(t0.getTime() + 89_999))).toBe(false); // renewed expiry = +90 s
        expect(await acquireLease(w.db, "stack:1:run", "B", 60_000, new Date(t0.getTime() + 91_000))).toBe(true); // expired ⇒ stolen
        expect(await releaseLease(w.db, "stack:1:run", "A")).toBe(false);
        expect(await releaseLease(w.db, "stack:1:run", "B")).toBe(true);
    });
    it("schedule state: one row per stack, failures counted/reset, deleted with the stack", async () => {
        const org = await seedOrg(w.pool);
        const stack = await seedStack(w.pool, org, null, "sched");
        const t = new Date("2026-02-01T00:00:00Z");
        await touchScheduleState(w.db, stack, {lastScheduledAt: t, lastRunStartedAt: t, lastRunStatus: "running"});
        await touchScheduleState(w.db, stack, {lastRunFinishedAt: t, lastRunStatus: "failed"});
        await touchScheduleState(w.db, stack, {lastRunStatus: "failed"});
        const row = async () => (await q("select * from fork_schedule_state where stack_id=$1", [stack])).rows;
        expect((await row())).toHaveLength(1);
        expect((await row())[0].consecutive_failures).toBe(2);
        await touchScheduleState(w.db, stack, {lastRunStatus: "success", lastVerifiedRpAt: t});
        expect((await row())[0]).toMatchObject({consecutive_failures: 0, last_run_status: "success"});
        expect((await row())[0].last_verified_rp_at.toISOString()).toBe(t.toISOString());
        await q("delete from fork_stack where id=$1", [stack]);
        expect(await row()).toHaveLength(0);
    });
});
