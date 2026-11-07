import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {contentHash, type StackInventoryV1} from "@/fork/inventory/schema";
import type {MaterializeDeps} from "@/fork/materialize/apply";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {activateStackPolicy} from "@/fork/stack-policy/activate";
import {loadConfigureView, ConfigureViewSchema} from "@/fork/stack-policy/configure-view";
import {loadPolicyView} from "@/fork/stack-policy/policy-view";
import {previewStackPolicy} from "@/fork/stack-policy/preview-service";
import {loadStackDetail} from "@/fork/stacks/queries";
import {w10Inventory} from "@/fork/__tests__/w10-fixtures";
import {freshForkDb, seedAgent, seedChannel, seedConnection, seedEnvironment, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let org: string; let otherOrg: string; let env: string; let s3: string;
const KEY = Buffer.alloc(32, 9);
const USER = "00000000-0000-4000-8000-0000000000aa";
const principal = (systemRole: string, orgRole: string | null, orgId = org): ForkPrincipal => ({userId: USER, systemRole, memberships: orgRole ? [{organizationId: orgId, role: orgRole}] : []});
const deps = (p: ForkPrincipal | null = principal("admin", "owner"), over: Partial<MaterializeDeps> = {}): MaterializeDeps =>
    ({db: t.db, principal: p, masterKey: async () => KEY, assertConfigAllowed: async () => undefined, rate: () => ({ok: true}), ...over});
const q = (s: string, p: unknown[] = []) => pool.query(s, p);

async function mkStack(inv: StackInventoryV1 = w10Inventory()): Promise<string> {
    const project = `s${randomUUID().slice(0, 8)}`;
    const i = {...inv, stack: {...inv.stack, compose_project: project, display_name: project}};
    const r = await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name) values ($1,$2,'env',$3,$3) returning id", [org, env, project]);
    await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [r.rows[0].id, contentHash(i), JSON.stringify(i)]);
    return r.rows[0].id;
}

beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool;
    org = await seedOrg(pool, "solo"); otherOrg = await seedOrg(pool, "other");
    const agent = await seedAgent(pool, org, "lab-agent");
    await q("update agents set version='1.25.2', last_contact=now() where id=$1", [agent]);
    s3 = (await q("insert into storage_channel (organization_id, provider, name, config, enabled) values ($1,'s3','offsite','{\"secretAccessKey\":\"CHANNEL-SECRET-CANARY\",\"bucket\":\"b\"}',true) returning id", [org])).rows[0].id;
    await seedChannel(pool, org, "dashboard-local");
    await seedChannel(pool, otherOrg, "foreign-channel");
    env = await seedEnvironment(pool, await seedConnection(pool, org), agent, "lab-agent");
    await q("update fork_arcane_environment set enabled=true where id=$1", [env]);
    await q("insert into settings (name, encryption) values ('w11', true)");
});
afterAll(async () => { await t?.drop(); });
beforeEach(() => resetRateLimits());

describe("W11 configure view DTO", () => {
    it("is strict, org-scoped, lists only this org's channels by id/name/provider, never their config", async () => {
        const id = await mkStack();
        const v = await loadConfigureView(t.db, org, id);
        expect(v).not.toBeNull();
        const json = JSON.stringify(v);
        expect(json).not.toContain("CHANNEL-SECRET-CANARY");
        expect(json).not.toContain("foreign-channel");
        expect(v!.channels.map((c) => [c.name, c.provider, c.local, c.deletable])).toEqual([["dashboard-local", "local", true, "not_checked"], ["offsite", "s3", false, "not_checked"], ["System", "local", true, "not_checked"]]) // "System" = upstream's seeded global channel;
        expect(v!.encryptionOn).toBe(true);
        expect(v!.composeDir).toBe("/srv/app");
        expect(v!.volumes).toEqual([{name: "app_data", sizeBytes: null}]);
        expect(v!.existing.active).toBe(false);
        expect(ConfigureViewSchema.safeParse({...v, extra: 1}).success).toBe(false);
        expect(await loadConfigureView(t.db, otherOrg, id)).toBeNull(); // another organization's: identical to missing
        expect(await loadConfigureView(t.db, org, randomUUID())).toBeNull();
    });

    it("nothing is written by viewing or previewing (persist only on Activate)", async () => {
        const id = await mkStack();
        await loadConfigureView(t.db, org, id);
        const r = await previewStackPolicy(deps(), {stackId: id, selection: {excludeKeys: ["volume:app_data"]}});
        expect(r.ok).toBe(true);
        expect((await q("select count(*)::int n from fork_stack_policy where stack_id=$1", [id])).rows[0].n).toBe(0);
        expect((await q("select count(*)::int n from fork_stack_source where stack_id=$1", [id])).rows[0].n).toBe(0);
        expect((await q("select count(*)::int n from fork_audit_event")).rows[0].n).toBe(0);
    });

    it("preview: authorisation, rate limit, strict input; shows plan verdicts and honest gaps", async () => {
        const id = await mkStack();
        expect(await previewStackPolicy(deps(null), {stackId: id})).toMatchObject({ok: false, code: "forbidden"});
        expect(await previewStackPolicy(deps(principal("user", "owner")), {stackId: id})).toMatchObject({ok: false, code: "forbidden"});
        expect(await previewStackPolicy(deps(), {stackId: randomUUID()})).toMatchObject({ok: false, code: "not_found"});
        expect(await previewStackPolicy(deps(), {stackId: id, password: "x"})).toMatchObject({ok: false, code: "invalid_input"});
        expect(await previewStackPolicy(deps(undefined, {rate: () => ({ok: false, retryAfterSeconds: 3})}), {stackId: id})).toMatchObject({ok: false, code: "rate_limited"});
        const r = await previewStackPolicy(deps(), {stackId: id, selection: {excludeKeys: ["volume:app_data"]}});
        if (!r.ok) throw new Error("preview failed");
        expect(r.preview.items.find((i) => i.key === "volume:app_data")).toMatchObject({plan: "not_backed_up", gap: true});
        expect(r.preview.items.find((i) => i.key === "file:/srv/app/compose.yml")).toMatchObject({plan: "backed_up"});
        expect(r.preview.sources.map((s) => s.role).sort()).toEqual(["bind", "compose"]);
        expect(r.preview.gaps).toBeGreaterThan(0);
    });
});

describe("W11 activated policy shows on the stack (Schedule tab data)", () => {
    it("null before activation, the policy after (names + settings only)", async () => {
        const id = await mkStack();
        expect(await loadPolicyView(t.db, id)).toBeNull();
        expect((await loadStackDetail(t.db, org, id))!.policy).toBeNull();
        const r = await activateStackPolicy(deps(), {stackId: id, storageChannelIds: [s3], schedule: {preset: "weekly", timezone: "UTC", hour: 3, minute: 0, weekday: 1}});
        expect(r.ok).toBe(true);
        const p = (await loadStackDetail(t.db, org, id))!.policy;
        expect(p).toMatchObject({cron: "0 3 * * 1", consistency: "crash", sourceCount: 2, channels: [{name: "offsite", provider: "s3", local: false}], retention: {keep_last: 3}});
        expect(p!.nextRuns).toHaveLength(3);
        expect(JSON.stringify(p)).not.toContain("CHANNEL-SECRET-CANARY");
        const view = await loadConfigureView(t.db, org, id);
        expect(view!.existing).toMatchObject({active: true, channelIds: [s3], schedule: {preset: "weekly", weekday: 1}});
    });
});
