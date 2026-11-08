import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {recordAudit} from "@/fork/audit";
import {verifyAuditChainDaily} from "@/fork/audit-task";
import {freshForkDb, type W04Db} from "@/fork/__tests__/w04-helpers";

/** W27a F-06: the daily chain verification really runs and a tampered row produces exactly one `fork.audit.chain_broken` event (no row content in it). */
let t: W04Db;
const t0 = new Date();
beforeAll(async () => { t = await freshForkDb(); });
afterAll(async () => { await t?.drop(); });
const count = async () => Number((await t.pool.query("select count(*)::int n from fork_audit_event where action='fork.audit.chain_broken'")).rows[0].n);

describe("audit chain runtime verification (F-06)", () => {
    it("a clean chain records nothing; a tampered row records one chain_broken event with the first bad seq and no content; the next call inside 24 h does not run again", async () => {
        for (let i = 0; i < 4; i++) await recordAudit(t.db, {actorKind: "system", action: "fork.test.event", result: "success", details: {n: i}, now: new Date(t0.getTime() + i)});
        expect(await verifyAuditChainDaily(t.db, t0, true)).toEqual({ran: true, ok: true});
        expect(await count()).toBe(0);
        const victim = (await t.pool.query("select seq from fork_audit_event order by seq limit 1 offset 2")).rows[0].seq;
        await t.pool.query("alter table fork_audit_event disable trigger fork_audit_event_append_only"); // a DB superuser bypasses the append-only trigger (tamper-EVIDENT, not tamper-proof)
        await t.pool.query("update fork_audit_event set event_hash = repeat('0', 64) where seq = $1", [victim]);
        await t.pool.query("alter table fork_audit_event enable trigger fork_audit_event_append_only");
        expect(await verifyAuditChainDaily(t.db, new Date(t0.getTime() + 60_000), true)).toEqual({ran: true, ok: false});
        expect(await count()).toBe(1);
        const row = (await t.pool.query("select result, redacted_details from fork_audit_event where action='fork.audit.chain_broken'")).rows[0];
        expect(row.result).toBe("failure");
        expect(row.redacted_details).toMatchObject({first_bad_seq: Number(victim), reason: "hash-mismatch"});
        expect(JSON.stringify(row.redacted_details)).not.toMatch(/fork\.test\.event/);
        expect(await verifyAuditChainDaily(t.db, new Date(t0.getTime() + 120_000))).toEqual({ran: false, ok: null}); // daily, not per run
    });
});
