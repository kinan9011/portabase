import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {cleanInventory, FULL_COVERAGE} from "@/fork/__tests__/w09-fixtures";
import {CANARY, richInventory} from "@/fork/__tests__/w08-fixtures";
import {freshForkDb, seedConnection, seedEnvironment, seedOrg, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {contentHash, type StackInventoryV1} from "@/fork/inventory/schema";
import {StackDetailSchema} from "@/fork/stacks/dto";
import {loadStackDetail} from "@/fork/stacks/queries";

let t: W04Db; let pool: Pool; let orgA: string; let orgB: string; let envA: string;
const NOW = new Date("2026-11-07T12:00:00Z");

async function stack(org: string, env: string | null, project: string, inv: StackInventoryV1 | unknown | null, o: {protection?: string; stale?: boolean} = {}) {
    const id = await seedStack(pool, org, env, project);
    await pool.query("update fork_stack set protection_state=$2, stale_since=$3 where id=$1", [id, o.protection ?? "unprotected", o.stale ? new Date("2026-11-07T00:00:00Z") : null]);
    if (inv) await pool.query("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [id, typeof inv === "object" && "schema_version" in (inv as object) ? contentHash(inv as StackInventoryV1) : "0".repeat(64), JSON.stringify(inv)]);
    return id;
}
const policy = (id: string, active = true) => pool.query("insert into fork_stack_policy (stack_id, activated_at, deactivated_at) values ($1, $2, null)", [id, active ? new Date("2026-11-01T00:00:00Z") : null]);
let seq = 0;
const rp = (id: string, status: string, o: {verifiedAt?: Date; reason?: string; created?: Date} = {}) =>
    pool.query("insert into fork_recovery_point (stack_id, stack_name, sequence, status, verified_at, downgrade_reason, created_at) values ($1,'n',$2,$3,$4,$5,$6)",
        [id, ++seq, status, o.verifiedAt ?? null, o.reason ?? (status === "failed" ? "verify_failed" : null), o.created ?? NOW]);
const inv = (id: string) => loadStackDetail(t.db, orgA, id, {now: NOW, configLocked: false});
const ok = async (id: string, extra: Parameters<typeof loadStackDetail>[3] = {}) => {
    const d = (await loadStackDetail(t.db, orgA, id, {now: NOW, ...extra}))!;
    if (d.inventory.state !== "ok") throw new Error("inventory not ok");
    return d.inventory;
};

beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool;
    orgA = await seedOrg(pool, "a"); orgB = await seedOrg(pool, "b");
    envA = await seedEnvironment(pool, await seedConnection(pool, orgA));
    // W10 (D39): an ACTIVE policy with backup encryption off is a blocker; these W09 scenarios are about the other inputs, so encryption is on.
    await pool.query("insert into settings (name, encryption) values ('w09', true)");
});
afterAll(async () => { await t?.drop(); });

describe("W09 protection loader (real Postgres)", () => {
    it("a discovered lab stack, nothing configured: Unprotected, NOT complete, blockers listed, strict DTO", async () => {
        const id = await stack(orgA, envA, "forklab-demo", richInventory());
        const d = await ok(id);
        StackDetailSchema.parse(await inv(id));
        expect(d.protection).toMatchObject({primary: "unprotected", complete: false, recoveryPoints: {verified: 0, pending: 0}});
        expect(d.protection.counts.blockers).toBeGreaterThan(0);
        expect(d.protection.facets).toMatchObject({deletable: "not_checked", hostCompromise: false, testRestore: {daysAgo: null}, lastGoodBackup: {hoursAgo: null, verifying: false}});
        expect(d.configuration.items.every((i) => i.status !== "captured")).toBe(true); // nothing is covered before W10
        expect(d.configuration.inventoryHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("active policy and no recovery point ⇒ Partial when gaps exist (the lab shape has gaps)", async () => {
        const id = await stack(orgA, envA, "gappy", richInventory({project: "gappy"})); await policy(id);
        expect((await ok(id)).protection.primary).toBe("partial");
    });

    it("active policy, full coverage (injected), no RP ⇒ Kit not verified (kit is never verified before W14: fail closed), never Protected", async () => {
        const id = await stack(orgA, envA, "clean-kit", cleanInventory()); await policy(id);
        const d = await ok(id, {ctxOverride: FULL_COVERAGE});
        expect(d.protection.complete).toBe(true);
        expect(d.protection.primary).toBe("kit_not_verified");
        await rp(id, "verified", {verifiedAt: new Date("2026-11-07T10:00:00Z")});
        const d2 = await ok(id, {ctxOverride: FULL_COVERAGE});
        expect(d2.protection.primary).toBe("kit_not_verified"); // Protected needs a verified kit (W14)
        expect(d2.protection.facets.lastGoodBackup.hoursAgo).toBeCloseTo(2, 5);
    });

    it("D43: pending_verification only ⇒ 'verifying', counted separately, last good backup stays empty", async () => {
        const id = await stack(orgA, envA, "pending", cleanInventory()); await policy(id);
        await rp(id, "pending_verification");
        const d = await ok(id, {ctxOverride: FULL_COVERAGE});
        expect(d.protection.recoveryPoints).toEqual({verified: 0, pending: 1});
        expect(d.protection.facets.lastGoodBackup).toEqual({hoursAgo: null, verifying: true});
        expect(d.protection.primary).not.toBe("protected");
    });

    it("latest RP failed ⇒ Failed beats everything", async () => {
        const id = await stack(orgA, envA, "failed", cleanInventory()); await policy(id);
        await rp(id, "verified", {verifiedAt: new Date("2026-11-07T10:00:00Z")});
        await rp(id, "failed");
        expect((await ok(id, {ctxOverride: FULL_COVERAGE})).protection.primary).toBe("failed");
    });

    it("old verified RP + a known schedule ⇒ Stale; incomplete/purged RPs do not count as verified", async () => {
        const id = await stack(orgA, envA, "stale", cleanInventory()); await policy(id);
        await rp(id, "verified", {verifiedAt: new Date("2026-11-01T00:00:00Z")});
        await rp(id, "incomplete");
        const d = await ok(id, {ctxOverride: FULL_COVERAGE, staleAfterHours: 48});
        expect(d.protection.primary).toBe("stale");
        expect(d.protection.recoveryPoints).toEqual({verified: 1, pending: 0});
    });

    it("a deactivated policy is not active", async () => {
        const id = await stack(orgA, envA, "deact", cleanInventory());
        await pool.query("insert into fork_stack_policy (stack_id, activated_at, deactivated_at) values ($1, now() - interval '2 day', now() - interval '1 day')", [id]);
        expect((await ok(id, {ctxOverride: FULL_COVERAGE})).protection.primary).toBe("unprotected");
    });

    it("facets: paused (protection_state), inventory stale (stale_since), config locked (mode)", async () => {
        const id = await stack(orgA, envA, "facets", cleanInventory(), {protection: "paused", stale: true}); await policy(id);
        const d = await ok(id, {configLocked: true, ctxOverride: FULL_COVERAGE});
        expect(d.protection.facets).toMatchObject({pausedAfterReauthorization: true, inventoryStale: true, configLocked: true, hostCompromise: true});
    });

    it("the environment's allowed_path_roots drive 'outside allowed roots'", async () => {
        const id = await stack(orgA, envA, "roots", cleanInventory());
        await pool.query("update fork_arcane_environment set allowed_path_roots = $2 where id = $1", [envA, ["/srv/elsewhere"]]);
        const d = await ok(id, {ctxOverride: FULL_COVERAGE});
        expect(d.configuration.items.find((i) => i.kind === "bind")).toMatchObject({status: "unsupported", reason: "outside_allowed_roots"});
        await pool.query("update fork_arcane_environment set allowed_path_roots = '{}' where id = $1", [envA]);
    });

    it("tier 2 inventory: env NAMES reach the DTO, VALUES cannot (there is no field), canary absent", async () => {
        const i = cleanInventory(); i.services[0]!.env_keys = ["DATABASE_URL", "TOKEN_NAME"];
        (i as any).provenance = {"/x": "arcane_list"};
        const id = await stack(orgA, envA, "tier2", i);
        const json = JSON.stringify(await inv(id));
        expect(json).toContain("DATABASE_URL");
        for (const s of ["env_values", "container_id", "provenance", CANARY, "api_key"]) expect(json).not.toContain(s);
    });

    it("tier 1 inventory (compose not read): no env names at all, 'undetermined' item present", async () => {
        const id = await stack(orgA, envA, "tier1", richInventory({project: "tier1"}));
        const d = await ok(id);
        expect(d.configuration.envNames).toEqual([]);
        expect(JSON.stringify(d)).not.toContain("POSTGRES_PASSWORD");
        expect(d.configuration.items.some((x) => x.reason === "env_files_undetermined" && x.status === "unknown")).toBe(true);
    });

    it("another organization's stack is not loadable through this organization (no oracle)", async () => {
        const id = await stack(orgB, null, "foreign", richInventory({project: "foreign"}));
        expect(await loadStackDetail(t.db, orgA, id, {now: NOW})).toBeNull();
    });

    it("unreadable / absent inventory: honest states, no crash, no protection view invented", async () => {
        const bad = await stack(orgA, envA, "bad", {schema_version: 1, junk: CANARY});
        const none = await stack(orgA, envA, "none", null);
        expect((await inv(bad))!.inventory).toEqual({state: "unreadable"});
        expect((await inv(none))!.inventory).toEqual({state: "none"});
    });

    it("read-only: loading a detail writes nothing (policy, RP, audit, inventory row counts unchanged)", async () => {
        const id = await stack(orgA, envA, "ro", cleanInventory());
        const count = async () => (await pool.query("select (select count(*) from fork_stack_policy)::int p, (select count(*) from fork_recovery_point)::int r, (select count(*) from fork_audit_event)::int a, (select count(*) from fork_stack_inventory)::int i, (select count(*) from fork_stack)::int s")).rows[0];
        const before = await count();
        await inv(id); await inv(id);
        expect(await count()).toEqual(before);
    });
});
