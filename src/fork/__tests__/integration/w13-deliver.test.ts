import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import {enqueueForkNotification} from "@/fork/notify";
import {defaultNotificationChannel} from "@/fork/upstream/notification-channel";
import {deliverPending, type DeliverDeps} from "@/fork/notifications/deliver";
import {evaluateAlerts} from "@/fork/notifications/evaluate";
import {DELIVERABLE_KINDS, MAX_ATTEMPTS, NO_CHANNEL_GIVE_UP_MS} from "@/fork/notifications/vocab";
import {mkWorld, T0, type World} from "@/fork/__tests__/w12-fixtures";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let w: World;
const CANARY = "/srv/secret stack.env";
beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool;
    w = await mkWorld(t);
    await pool.query("update fork_stack set display_name = $2 where id = $1", [w.stackId, `shop ${CANARY}`]);
});
afterAll(async () => { await t?.drop(); });
beforeEach(async () => { await pool.query("delete from fork_notification_outbox"); await pool.query("delete from fork_alert_state"); });
const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
const CH = {id: "11111111-1111-4111-8111-111111111111", organizationId: null as string | null};
type Sent = Parameters<DeliverDeps["send"]>[1];
const mk = (o: {channel?: typeof CH | null; send?: (m: Sent) => Promise<boolean>; now?: Date} = {}) => {
    const sent: Sent[] = [];
    const deps: DeliverDeps = {
        db: t.db, now: () => o.now ?? new Date(T0), baseUrl: "https://pb.example.test",
        resolveChannel: async () => (o.channel === undefined ? CH : o.channel),
        send: async (_c, m) => { sent.push(m); return o.send ? o.send(m) : true; },
    };
    return {deps, sent};
};
// rows are eligible at the injected clock T0: the DB default now() is the REAL clock and is later than a fixed T0 (failed from 2026-11-07 10:00Z)
const enq = async (kind: string, key: string, payload: Record<string, unknown> = {}) => { const r = await enqueueForkNotification(t.db, {kind, dedupeKey: key, payload: {stackId: w.stackId, reason: "member_timeout", hours: 30, link: `/dashboard/stacks/${w.stackId}`, ...payload}}); await pool.query("update fork_notification_outbox set created_at = $1, next_attempt_at = $1 where dedupe_key = $2", [new Date(T0.getTime() - 1000), key]); return r; };

describe("W13 delivery: every §4.7 kind → exactly one sanitised notification through the channel", () => {
    it.each(DELIVERABLE_KINDS)("%s: delivered once, body = fixed sentences + sanitised name + link (canary absent)", async (kind) => {
        await enq(kind, `${kind}:1`, {path: "/srv/secret", error: "CANARY-RAW-ERROR", codes: ["MINIO_ROOT_PASSWORD"]});
        const {deps, sent} = mk();
        const r = await deliverPending(deps);
        expect(r).toMatchObject({claimed: 1, delivered: 1});
        expect(sent).toHaveLength(1);
        const text = `${sent[0].title}\n${sent[0].message}`;
        for (const bad of ["CANARY", "/srv", "stack.env", "MINIO", "evil", "AKIA"]) expect(text).not.toContain(bad);
        expect(text).toContain("https://pb.example.test/dashboard/stacks");
        const row = (await q("select state, attempts, delivered_at, last_error_code from fork_notification_outbox"))[0];
        expect(row).toMatchObject({state: "delivered", attempts: 1, last_error_code: null});
        expect(row.delivered_at).toBeTruthy();
        // a second pass sends nothing more
        expect((await deliverPending(deps)).claimed).toBe(0);
        expect(sent).toHaveLength(1);
    });

    it("the stack name is sanitised but present; an enqueue with the same dedupe key is a no-op (one row per state change)", async () => {
        expect(await enq("run.failed", "run.failed:A")).toBe(true);
        expect(await enq("run.failed", "run.failed:A")).toBe(false);
        const {deps, sent} = mk();
        await deliverPending(deps);
        expect(sent).toHaveLength(1);
        expect(sent[0].message.split("\n")[0]).toBe("shop srvsecret stack_env: The backup failed.");
    });
});

describe("W13 delivery: honest outcomes", () => {
    it("no default channel: nothing is claimed delivered; the row waits, then fails with `no_channel` after 24 h", async () => {
        await enq("run.failed", "run.failed:nc");
        const a = mk({channel: null});
        expect(await deliverPending(a.deps)).toMatchObject({waitingNoChannel: 1, delivered: 0});
        expect((await q("select state, last_error_code from fork_notification_outbox"))[0]).toMatchObject({state: "pending", last_error_code: "no_channel"});
        expect(a.sent).toHaveLength(0);
        // not due again immediately
        expect((await deliverPending(a.deps)).claimed).toBe(0);
        // a channel appears later: the pending row is delivered
        const b = mk({now: new Date(T0.getTime() + 11 * 60_000)});
        expect(await deliverPending(b.deps)).toMatchObject({delivered: 1});
        // …but a row older than 24 h without any channel fails for good, never "sent"
        await enq("run.failed", "run.failed:nc2");
        await pool.query("update fork_notification_outbox set created_at = $1, next_attempt_at = $1 where dedupe_key = 'run.failed:nc2'", [new Date(T0.getTime() - NO_CHANNEL_GIVE_UP_MS - 1000)]);
        expect(await deliverPending(mk({channel: null}).deps)).toMatchObject({failed: 1});
        expect((await q("select state, last_error_code from fork_notification_outbox where dedupe_key='run.failed:nc2'"))[0]).toMatchObject({state: "failed", last_error_code: "no_channel"});
    });

    it("provider failure: backoff retries, then `failed` with a closed code after MAX_ATTEMPTS (no provider text stored)", async () => {
        await enq("run.failed", "run.failed:pf");
        let now = new Date(T0);
        for (let i = 1; i < MAX_ATTEMPTS; i++) {
            const r = await deliverPending(mk({send: async () => false, now}).deps);
            expect(r).toMatchObject({retried: 1});
            const row = (await q("select state, attempts, last_error_code, next_attempt_at from fork_notification_outbox"))[0];
            expect(row).toMatchObject({state: "pending", attempts: i, last_error_code: "provider_error"});
            // not due before the backoff elapsed
            expect((await deliverPending(mk({send: async () => false, now}).deps)).claimed).toBe(0);
            now = new Date(new Date(row.next_attempt_at).getTime() + 1000);
        }
        expect(await deliverPending(mk({send: async () => false, now}).deps)).toMatchObject({failed: 1});
        expect((await q("select state, attempts, last_error_code from fork_notification_outbox"))[0]).toEqual({state: "failed", attempts: MAX_ATTEMPTS, last_error_code: "provider_error"});
    });

    it("a throwing sender is a failed attempt, not a crash and not 'delivered'", async () => {
        await enq("run.failed", "run.failed:th");
        const r = await deliverPending(mk({send: async () => { throw new Error("CANARY-RAW-ERROR https://u:p@x"); }}).deps);
        expect(r.retried).toBe(1);
        expect(JSON.stringify(await q("select * from fork_notification_outbox"))).not.toContain("CANARY");
    });

    it("kinds that are not a §4.7 trigger are `suppressed`, never delivered", async () => {
        await enqueueForkNotification(t.db, {kind: "discovery.circuit_open", dedupeKey: "dc:1", payload: {state: "circuit_open"}});
        await pool.query("update fork_notification_outbox set created_at = $1, next_attempt_at = $1", [new Date(T0.getTime() - 1000)]);
        const {deps, sent} = mk();
        expect(await deliverPending(deps)).toMatchObject({suppressed: 1, delivered: 0});
        expect(sent).toHaveLength(0);
        expect((await q("select state from fork_notification_outbox"))[0].state).toBe("suppressed");
    });

    it("two concurrent workers never send the same row twice (claim lease + SKIP LOCKED)", async () => {
        for (let i = 0; i < 6; i++) await enq("run.failed", `run.failed:race${i}`);
        const slow = (m: Sent) => new Promise<boolean>((res) => setTimeout(() => res(!!m), 30));
        const a = mk({send: slow}); const b = mk({send: slow});
        const [ra, rb] = await Promise.all([deliverPending({...a.deps, batch: 4}), deliverPending({...b.deps, batch: 4})]);
        expect(ra.delivered + rb.delivered).toBe(6 - (await q("select 1 from fork_notification_outbox where state='pending'")).length);
        await deliverPending(a.deps);
        expect(a.sent.length + b.sent.length).toBe(6);
        expect((await q("select count(*)::int c from fork_notification_outbox where state='delivered'"))[0].c).toBe(6);
    });
});

describe("W13 alert evaluation (dead-man, drift to Partial) — once per episode, durable", () => {
    const run = (hours: number) => evaluateAlerts({db: t.db, now: () => new Date(T0.getTime() + hours * 3_600_000), configLocked: false, minHours: 12});
    const outbox = (kind: string, stackId = w.stackId) => q("select dedupe_key, payload from fork_notification_outbox where kind=$1 and payload->>'stackId'=$2 order by dedupe_key", [kind, stackId]);
    const rp = (seq: number, status: string, at: Date) => pool.query(
        "insert into fork_recovery_point (stack_id, stack_name, sequence, status, created_at, finalized_at, verified_at) values ($1,'s',$2,$3,$4,$4,$5)", [w.stackId, seq, status, at, status === "verified" ? at : null]);
    beforeEach(async () => { await pool.query("delete from fork_recovery_point where stack_id=$1", [w.stackId]); });

    it("dead-man counts VERIFIED RPs only: pending_verification does not stop it; one notification per episode; a verified RP clears it; a later gap fires a NEW one", async () => {
        await rp(1, "pending_verification", new Date(T0.getTime() + 3_600_000)); // "Backed up · verifying" is not a good backup (D43)
        expect((await run(2)).errors).toBe(0);
        const first = await outbox("stack.no_good_backup");
        expect(first.map((r) => r.dedupe_key)).toEqual([`stack.no_good_backup:${w.stackId}:1`]);
        expect(first[0].payload).toMatchObject({state: "no_good_backup", stackId: w.stackId, hours: 50}); // activated 2 d before T0, now T0+2h
        await run(3); await run(4);
        expect(await outbox("stack.no_good_backup")).toHaveLength(1);

        await rp(2, "verified", new Date(T0.getTime() + 5 * 3_600_000)); // a verified RP (W14) clears the condition silently
        await run(6);
        expect(await outbox("stack.no_good_backup")).toHaveLength(1);
        expect((await q("select active, epoch from fork_alert_state where stack_id=$1 and kind='stack.no_good_backup'", [w.stackId]))[0]).toEqual({active: false, epoch: 1});

        await run(5 + 40); // 40 h without a verified RP, limit = max(12, 1.5 × 24) = 36
        expect((await outbox("stack.no_good_backup")).map((r) => r.dedupe_key)).toEqual([`stack.no_good_backup:${w.stackId}:1`, `stack.no_good_backup:${w.stackId}:2`]);
    });

    it("drift to Partial: a coverage gap on an active stack notifies once", async () => {
        const g = await mkWorld(t, {covers: false});
        await rp(1, "pending_verification", T0).catch(() => undefined);
        await evaluateAlerts({db: t.db, now: () => new Date(T0.getTime() + 3_600_000), configLocked: false, minHours: 12});
        const rows = await outbox("stack.partial", g.stackId);
        expect(rows.map((r) => r.dedupe_key)).toEqual([`stack.partial:${g.stackId}:1`]);
        await evaluateAlerts({db: t.db, now: () => new Date(T0.getTime() + 7_200_000), configLocked: false, minHours: 12});
        expect(await outbox("stack.partial", g.stackId)).toHaveLength(1);
    });

    it("works while the fork is locked (configLocked only changes a facet, never stops evaluation)", async () => {
        const r = await evaluateAlerts({db: t.db, now: () => new Date(T0.getTime() + 3_600_000), configLocked: true, minHours: 12});
        expect(r.errors).toBe(0);
        expect((await outbox("stack.no_good_backup")).length).toBe(1);
    });
});

describe("W13 upstream default channel lookup (real `settings` + `notification_channel` rows)", () => {
    it("returns the instance default channel only while it exists AND is enabled; never its config", async () => {
        await pool.query("insert into settings (name) values ('system') on conflict (name) do nothing"); // the upstream settings row the dispatcher reads
        await pool.query("update settings set default_notification_channel_id = null");
        expect(await defaultNotificationChannel(t.db)).toBeNull();
        const ch = (await pool.query("insert into notification_channel (provider, name, config, enabled) values ('webhook','alerts','{\"url\":\"https://CANARY-SECRET.example/hook\"}',true) returning id")).rows[0].id as string;
        await pool.query("update settings set default_notification_channel_id = $1 where name = 'system'", [ch]);
        const found = await defaultNotificationChannel(t.db);
        expect(found).toEqual({id: ch, organizationId: null});
        expect(JSON.stringify(found)).not.toContain("CANARY");
        await pool.query("update notification_channel set enabled = false where id = $1", [ch]);
        expect(await defaultNotificationChannel(t.db)).toBeNull();
        await pool.query("update settings set default_notification_channel_id = null");
    });
});
