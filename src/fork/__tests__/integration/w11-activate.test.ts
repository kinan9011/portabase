import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {afterAll, beforeAll, beforeEach, describe, expect, it} from "vitest";
import type {ForkPrincipal} from "@/fork/acl";
import {contentHash, type StackInventoryV1} from "@/fork/inventory/schema";
import {loadMaterializedContext} from "@/fork/materialize/context";
import type {MaterializeDeps} from "@/fork/materialize/apply";
import {ForkLockedError} from "@/fork/mode";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {activateStackPolicy, type ActivateResult} from "@/fork/stack-policy/activate";
import {loadProtectionViews} from "@/fork/stacks/protection";
import {w10Inventory} from "@/fork/__tests__/w10-fixtures";
import {freshForkDb, seedAgent, seedChannel, seedConnection, seedEnvironment, seedOrg, type W04Db} from "@/fork/__tests__/w04-helpers";

let t: W04Db; let pool: Pool; let org: string; let otherOrg: string; let agent: string; let env: string; let s3: string; let local: string; let foreign: string;
const KEY = Buffer.alloc(32, 9);
const USER = "00000000-0000-4000-8000-0000000000aa";
const principal = (systemRole: string, orgRole: string | null, orgId = org): ForkPrincipal => ({userId: USER, systemRole, memberships: orgRole ? [{organizationId: orgId, role: orgRole}] : []});
const deps = (p: ForkPrincipal | null = principal("admin", "owner"), over: Partial<MaterializeDeps> = {}): MaterializeDeps =>
    ({db: t.db, principal: p, masterKey: async () => KEY, assertConfigAllowed: async () => undefined, rate: () => ({ok: true}), ...over});
const q = (s: string, p: unknown[] = []) => pool.query(s, p);
const SCHEDULE = {preset: "daily", timezone: "Europe/Berlin", hour: 2, minute: 30};
const base = (stackId: string, o: Record<string, unknown> = {}) => ({stackId, storageChannelIds: [s3], schedule: SCHEDULE, ...o});

async function mkStack(inv: StackInventoryV1 = w10Inventory(), envId = env): Promise<string> {
    const project = `s${randomUUID().slice(0, 8)}`;
    const i = {...inv, stack: {...inv.stack, compose_project: project, display_name: project}};
    const r = await q("insert into fork_stack (organization_id, environment_id, environment_name, compose_project, display_name) values ($1,$2,'env',$3,$3) returning id", [org, envId, project]);
    await q("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,1,$2,$3)", [r.rows[0].id, contentHash(i), JSON.stringify(i)]);
    return r.rows[0].id;
}
const DB_INV = (): StackInventoryV1 => {
    const inv = w10Inventory();
    inv.services.push({name: "db", state: "running", image: {ref: "postgres:16", pinned: false, built_locally: false}, ports: [], networks: [], mounts: ["m:00000000000000a1"], env_keys: [], database_hint: {engine: "postgresql", basis: "image"}});
    inv.mounts.push({id: "m:00000000000000a1", kind: "named_volume", volume_name: "app_pgdata", destination: "/var/lib/postgresql/data", rw: true, consumers: ["db"], ownership: "stack_owned"});
    inv.volumes.push({name: "app_pgdata", driver: "local", in_use_by: ["db"], ownership: "stack_owned"});
    return inv;
};
const audits = async () => (await q("select action, result, redacted_details as details from fork_audit_event order by seq")).rows as {action: string; result: string; details: Record<string, unknown>}[];
const rows = async (id: string) => ({policy: (await q("select * from fork_stack_policy where stack_id=$1", [id])).rows[0], sources: (await q("select * from fork_stack_source where stack_id=$1", [id])).rows, stack: (await q("select * from fork_stack where id=$1", [id])).rows[0]});
const nothingWritten = async (id: string) => { const r = await rows(id); expect(r.policy).toBeUndefined(); expect(r.sources).toEqual([]); expect(r.stack.project_id).toBeNull(); };
const fail = (r: ActivateResult) => { if (r.ok) throw new Error("expected refusal"); return r; };

beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool;
    org = await seedOrg(pool, "solo"); otherOrg = await seedOrg(pool, "other");
    agent = await seedAgent(pool, org, "lab-agent");
    await q("update agents set version='1.25.2', last_contact=now() where id=$1", [agent]);
    s3 = (await q("insert into storage_channel (organization_id, provider, name, config, enabled) values ($1,'s3','offsite','{\"secretAccessKey\":\"CHANNEL-SECRET-CANARY\"}',true) returning id", [org])).rows[0].id;
    local = await seedChannel(pool, org, "dashboard-local");
    foreign = await seedChannel(pool, otherOrg, "foreign");
    await q("update storage_channel set provider='s3' where id=$1", [foreign]);
    env = await seedEnvironment(pool, await seedConnection(pool, org), agent, "lab-agent");
    await q("update fork_arcane_environment set enabled=true where id=$1", [env]);
    await q("insert into settings (name, encryption) values ('w11', true)");
});
afterAll(async () => { await t?.drop(); });
beforeEach(() => resetRateLimits());

describe("W11 activation: creates sources + schedule + the D31 authorization record", () => {
    it("activates; persists schedule, retention, channels, authorization (ids only); stack becomes active; audit has no selection/secret", async () => {
        const id = await mkStack();
        await nothingWritten(id); // persist ONLY on Activate (UX-04): nothing exists before
        const r = await activateStackPolicy(deps(), base(id, {retention: {keep_last: 5, daily: 7, weekly: 4, monthly: 6, yearly: 1}}));
        expect(r).toMatchObject({ok: true, created: 3, noop: false, cron: "30 2 * * *"});
        if (!r.ok) return;
        expect(r.nextRuns).toHaveLength(3);
        expect(r.deferred).toEqual([{key: "volume:app_data", reason: "docker_access_unconfirmed"}]); // honest: not covered yet, still activated
        const x = await rows(id);
        expect(x.policy.activated_at).not.toBeNull();
        expect(x.policy.activated_by).toBe(USER);
        expect(x.policy.deactivated_at).toBeNull();
        expect(x.policy.schedule).toMatchObject(SCHEDULE);
        expect(x.policy.policy).toEqual({keep_last: 5, daily: 7, weekly: 4, monthly: 6, yearly: 1});
        expect(x.policy.activation).toMatchObject({userId: USER, capability: "stacks.backup.manage", aclAgentId: agent, organizationId: org, encryption: true, channelIds: [s3]});
        expect(x.stack.protection_state).toBe("active");
        expect(x.sources.map((s) => [s.resource_key, s.status])).toEqual([["dir:/srv/app", "active"], ["mount:m:0000000000000002", "active"], ["volume:app_data", "planned"]]);
        const a = await audits();
        expect(a.map((e) => [e.action, e.result])).toEqual([["fork.materialize.apply", "success"], ["fork.stack_policy.activate", "success"]]);
        expect(a[1].details).toMatchObject({schedulePreset: "daily", timezone: "Europe/Berlin", channels: 1, reactivation: false});
        expect(JSON.stringify(a)).not.toContain("/srv/app");
    });

    it("an activated INCOMPLETE stack can never read Protected (validator + precedence), and the policy is visible to the loader", async () => {
        const id = await mkStack();
        await activateStackPolicy(deps(), base(id));
        const inv = w10Inventory();
        const {protection} = await loadProtectionViews(t.db, {id, staleSince: null, environmentId: env, protectionState: "active"}, {stored: inv, contentHash: null}, {configLocked: false});
        expect(protection.primary).not.toBe("protected");
        expect(["partial", "awaiting_first_backup", "kit_not_verified"]).toContain(protection.primary);
        expect(protection.complete).toBe(false);
    });

    it("re-activation is idempotent: no new sources, activated_at kept, activation record refreshed", async () => {
        const id = await mkStack();
        await activateStackPolicy(deps(), base(id));
        const first = await rows(id);
        const r = await activateStackPolicy(deps(), base(id, {schedule: {...SCHEDULE, hour: 4}}));
        expect(r).toMatchObject({ok: true, created: 0, updated: 0, noop: true});
        const second = await rows(id);
        expect(second.sources.map((s) => s.id)).toEqual(first.sources.map((s) => s.id));
        expect(second.policy.activated_at).toEqual(first.policy.activated_at);
        expect(second.policy.schedule).toMatchObject({hour: 4});
        expect((await audits()).at(-1)?.details).toMatchObject({reactivation: true});
    });

    it("feeds the dead-man threshold: daily ⇒ 1.5 × 24 h", async () => {
        const id = await mkStack();
        await activateStackPolicy(deps(), base(id));
        expect((await loadMaterializedContext(t.db, {id, environmentId: env})).staleAfterHours).toBe(36);
    });
});

describe("W11 activation: refusals leave NOTHING behind and are audited", () => {
    it("D39: encryption off ⇒ encryption_required", async () => {
        await q("update settings set encryption = false");
        try {
            const id = await mkStack();
            expect(fail(await activateStackPolicy(deps(), base(id)))).toMatchObject({code: "refused", reason: "encryption_required"});
            await nothingWritten(id);
            expect((await audits()).at(-1)).toMatchObject({action: "fork.stack_policy.activate", result: "denied", details: {reason: "encryption_required"}});
        } finally { await q("update settings set encryption = true"); }
    });

    it("§4.5: no channel / local-only ⇒ refused with the inline reason; a local + off-host mix is accepted", async () => {
        const id = await mkStack();
        expect(fail(await activateStackPolicy(deps(), base(id, {storageChannelIds: []})))).toMatchObject({reason: "no_channel_selected"});
        const l = fail(await activateStackPolicy(deps(), base(id, {storageChannelIds: [local]})));
        expect(l).toMatchObject({reason: "local_only_channels"});
        expect(l.message).toMatch(/lost with it; add an off-host channel/);
        await nothingWritten(id);
        expect(await activateStackPolicy(deps(), base(id, {storageChannelIds: [local, s3]}))).toMatchObject({ok: true});
    });

    it("a channel of another organization / unknown channel ⇒ channels_unavailable", async () => {
        const id = await mkStack();
        expect(fail(await activateStackPolicy(deps(), base(id, {storageChannelIds: [foreign]})))).toMatchObject({reason: "channels_unavailable"});
        expect(fail(await activateStackPolicy(deps(), base(id, {storageChannelIds: [randomUUID()]})))).toMatchObject({reason: "channels_unavailable"});
        await nothingWritten(id);
    });

    it("SEC-24: a path-like / anonymous / unknown docker-volume name is refused at the field, nothing is written", async () => {
        const id = await mkStack();
        for (const [name, code] of [["/tmp/x", "volume_name_path_like"], ["../etc", "volume_name_path_like"], ["a".repeat(64).replace(/a/g, "f"), "volume_name_anonymous"], ["nope", "volume_not_in_inventory"]] as const) {
            const r = fail(await activateStackPolicy(deps(), base(id, {selection: {includeKeys: [`volume:${name}`]}})));
            expect(r).toMatchObject({reason: "selection_invalid"});
            expect(r.issues).toEqual([{field: "volumes", key: `volume:${name}`, code}]);
        }
        await nothingWritten(id);
    });

    it("manual source: outside roots / no roots / unknown key ⇒ field issues; accepted exclusion of an unknown key ⇒ refused", async () => {
        const id = await mkStack();
        const noRoots = fail(await activateStackPolicy(deps(), base(id, {selection: {manual: [{path: "/srv/extra", covers: ["env:undetermined"]}]}})));
        expect(noRoots.issues).toEqual([{field: "manual:0", key: "manual:/srv/extra", code: "manual_roots_missing"}]);
        await q("update fork_arcane_environment set allowed_path_roots = array['/srv'] where id=$1", [env]);
        try {
            const out = fail(await activateStackPolicy(deps(), base(id, {selection: {manual: [{path: "/etc/shadow", covers: ["env:undetermined"]}]}})));
            expect(out.issues?.[0]).toMatchObject({field: "manual:0", code: "manual_invalid"});
            const unknownKey = fail(await activateStackPolicy(deps(), base(id, {selection: {manual: [{path: "/srv/extra", covers: ["volume:ghost"]}]}})));
            expect(unknownKey.issues?.[0]).toMatchObject({code: "manual_key_unknown"});
            const acc = fail(await activateStackPolicy(deps(), base(id, {acceptedExclusions: ["volume:ghost"]})));
            expect(acc.issues).toEqual([{field: "accepted", key: "volume:ghost", code: "key_unknown"}]);
            await nothingWritten(id);
        } finally { await q("update fork_arcane_environment set allowed_path_roots = '{}' where id=$1", [env]); }
    });

    it("invalid schedule/retention/unknown fields ⇒ invalid_input with paths and codes only (never the value)", async () => {
        const id = await mkStack();
        const r = fail(await activateStackPolicy(deps(), base(id, {schedule: {...SCHEDULE, preset: "daily", cron: "0 0 * * *"}, retention: {keep_last: 0, daily: 1, weekly: 1, monthly: 1, yearly: 0}, extra: "SECRET-IN-FIELD"})));
        expect(r.code).toBe("invalid_input");
        expect(r.fieldErrors?.map((f) => f.path).sort()).toContain("retention.keep_last");
        expect(JSON.stringify(r)).not.toContain("SECRET-IN-FIELD");
        expect(fail(await activateStackPolicy(deps(), base(id, {schedule: {...SCHEDULE, timezone: "Mars/Base"}}))).fieldErrors?.[0].path).toBe("schedule.timezone");
        await nothingWritten(id);
    });

    it("materializer refusals pass through with their reason and activate nothing (secret_required lists the service, no password echoed)", async () => {
        const id = await mkStack(DB_INV());
        const r = fail(await activateStackPolicy(deps(), base(id, {selection: {databases: {db: {kind: "dump", host: "demo-db", port: 5432, username: "demo", database: "demo"}}}})));
        expect(r).toMatchObject({code: "refused", reason: "secret_required", services: ["db"]});
        const x = await rows(id);
        expect(x.policy?.activated_at ?? null).toBeNull();
        expect(x.stack.protection_state).toBe("unprotected");
    });
});

describe("W11 authorization (D21, D31, SEC-12)", () => {
    it("anonymous, org member, org owner without system admin ⇒ forbidden; foreign/missing id ⇒ identical not_found; nothing written", async () => {
        const id = await mkStack();
        expect(fail(await activateStackPolicy(deps(null), base(id))).code).toBe("forbidden");
        expect(fail(await activateStackPolicy(deps(principal("user", "member")), base(id))).code).toBe("forbidden");
        expect(fail(await activateStackPolicy(deps(principal("user", "owner")), base(id))).code).toBe("forbidden");
        const foreignStack = fail(await activateStackPolicy(deps(principal("admin", "owner", otherOrg)), base(id)));
        const missing = fail(await activateStackPolicy(deps(), base(randomUUID())));
        expect(missing.code).toBe("not_found");
        expect(foreignStack.code === "forbidden" || foreignStack.code === "not_found").toBe(true);
        await nothingWritten(id);
        const a = await audits();
        expect(a.filter((e) => e.result === "denied").length).toBeGreaterThanOrEqual(4);
    });

    it("D31: a system admin who cannot manage the agent (member of the org, not owner/admin) is refused after the capability check", async () => {
        const id = await mkStack();
        const r = fail(await activateStackPolicy(deps(principal("admin", "member")), base(id)));
        expect(r.code).toBe("forbidden");
        await nothingWritten(id);
    });

    it("D21: while the self-check fails (locked) ⇒ locked, nothing written", async () => {
        const id = await mkStack();
        const r = fail(await activateStackPolicy(deps(undefined, {assertConfigAllowed: async () => { throw new ForkLockedError("locked", "self-check"); }}), base(id)));
        expect(r.code).toBe("locked");
        await nothingWritten(id);
    });

    it("rate limit ⇒ rate_limited (audited)", async () => {
        const id = await mkStack();
        const r = fail(await activateStackPolicy(deps(undefined, {rate: () => ({ok: false, retryAfterSeconds: 7})}), base(id)));
        expect(r).toMatchObject({code: "rate_limited", retryAfterSeconds: 7});
        await nothingWritten(id);
    });
});

describe("W11 secrets and compensation", () => {
    it("DB password canary: absent from policy, audit, result, links; channel secret canary never read", async () => {
        const id = await mkStack(DB_INV());
        const r = await activateStackPolicy(deps(), base(id, {selection: {databases: {db: {kind: "dump", host: "demo-db", port: 5432, username: "demo", database: "demo"}}}, secrets: {db: "Pw-W11-canary-9"}}));
        expect(r.ok).toBe(true);
        const everywhere = JSON.stringify([r, await rows(id), await audits()]);
        expect(everywhere).not.toContain("Pw-W11-canary-9");
        expect(everywhere).not.toContain("CHANNEL-SECRET-CANARY");
    });

    it("a failure of the activation step leaves materialized-but-NOT-active sources and says so; audited as failure", async () => {
        const id = await mkStack();
        await q(`create or replace function w11_fail() returns trigger language plpgsql as $$ begin if new.schedule <> '{}'::jsonb then raise exception 'boom'; end if; return new; end $$`);
        await q("create trigger w11_fail_t before update on fork_stack_policy for each row execute function w11_fail()");
        try {
            const r = fail(await activateStackPolicy(deps(), base(id)));
            expect(r).toMatchObject({code: "refused", reason: "activation_failed"});
            const x = await rows(id);
            expect(x.policy.activated_at).toBeNull();
            expect(x.stack.protection_state).toBe("unprotected");
            expect(x.sources.length).toBeGreaterThan(0);
            expect((await audits()).at(-1)).toMatchObject({action: "fork.stack_policy.activate", result: "failure", details: {step: "activation"}});
        } finally { await q("drop trigger w11_fail_t on fork_stack_policy"); }
    });
});

describe("W11 accepted exclusion (UX-20) round trip", () => {
    it("excluded required volume = gap (Partial); accepting it turns the item into 'accepted exclusion' in the validator", async () => {
        const id = await mkStack();
        const inv = w10Inventory();
        const view = async () => (await loadProtectionViews(t.db, {id, staleSince: null, environmentId: env, protectionState: "active"}, {stored: inv, contentHash: null}, {configLocked: false})).configuration.items.find((i) => i.key === "volume:app_data");
        await activateStackPolicy(deps(), base(id, {selection: {excludeKeys: ["volume:app_data"]}}));
        expect(await view()).toMatchObject({gap: true});
        await activateStackPolicy(deps(), base(id, {selection: {excludeKeys: ["volume:app_data"]}, acceptedExclusions: ["volume:app_data"]}));
        expect(await view()).toMatchObject({status: "accepted_exclusion", gap: false});
        const x = await rows(id);
        expect(x.policy.accepted_exclusions).toEqual(["volume:app_data"]);
        expect(x.sources.some((s) => s.resource_key === "volume:app_data")).toBe(false);
    });
});
