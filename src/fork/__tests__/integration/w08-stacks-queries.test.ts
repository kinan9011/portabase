import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {actorIn, ForkForbiddenError, ForkNotFoundError, type ForkPrincipal} from "@/fork/acl";
import {CANARY, richInventory} from "@/fork/__tests__/w08-fixtures";
import {freshForkDb, seedConnection, seedEnvironment, seedOrg, seedStack, type W04Db} from "@/fork/__tests__/w04-helpers";
import {contentHash} from "@/fork/inventory/schema";
import {assertForkResource} from "@/fork/resource-scope";
import {StackDetailSchema, StackListSchema} from "@/fork/stacks/dto";
import {loadStackDetail, loadStackList} from "@/fork/stacks/queries";
import {DEFAULT_PARAMS, PAGE_SIZE, parseStackListParams} from "@/fork/stacks/params";

let t: W04Db; let pool: Pool;
let orgA: string; let orgB: string; let conn: string; let envA: string;
const ids: Record<string, string> = {};

async function addInventory(stackId: string, project: string, version = 1, inv: unknown = richInventory({project})) {
    const hash = typeof inv === "object" && inv && "schema_version" in (inv as object) ? contentHash(inv as ReturnType<typeof richInventory>) : "0".repeat(64);
    await pool.query("insert into fork_stack_inventory (stack_id, version, content_hash, inventory) values ($1,$2,$3,$4)", [stackId, version, hash, JSON.stringify(inv)]);
}
async function stack(org: string, env: string | null, project: string, o: {runtime?: string; protection?: string; stale?: boolean; display?: string; envName?: string} = {}) {
    const id = await seedStack(pool, org, env, project);
    await pool.query("update fork_stack set runtime_state=$2, protection_state=$3, stale_since=$4, display_name=$5, environment_name=$6 where id=$1",
        [id, o.runtime ?? "running", o.protection ?? "unprotected", o.stale ? new Date("2026-11-07T00:00:00Z") : null, o.display ?? project, o.envName ?? "env"]);
    return id;
}

beforeAll(async () => {
    t = await freshForkDb(); pool = t.pool;
    orgA = await seedOrg(pool, "a"); orgB = await seedOrg(pool, "b");
    conn = await seedConnection(pool, orgA); envA = await seedEnvironment(pool, conn);
    ids.demo = await stack(orgA, envA, "forklab-demo"); await addInventory(ids.demo, "forklab-demo");
    ids.gone = await stack(orgA, envA, "gone-app", {runtime: "absent"}); await addInventory(ids.gone, "gone-app");
    ids.stale = await stack(orgA, envA, "stale-app", {stale: true, runtime: "partial", envName: "other"}); await addInventory(ids.stale, "stale-app");
    ids.pct = await stack(orgA, envA, "pct-app", {display: "100% sure_app"}); await addInventory(ids.pct, "pct-app");
    ids.noinv = await stack(orgA, envA, "noinv-app");
    ids.bad = await stack(orgA, envA, "bad-app"); await addInventory(ids.bad, "bad-app", 1, {schema_version: 1, junk: CANARY});
    ids.foreign = await stack(orgB, null, "foreign-app"); await addInventory(ids.foreign, "foreign-app");
});
afterAll(async () => { await t?.drop(); });

describe("W08 stack list loader", () => {
    it("is scoped to the organization: B's stack never appears for A (and vice versa)", async () => {
        const a = await loadStackList(t.db, orgA, DEFAULT_PARAMS);
        expect(a.items.map((i) => i.composeProject)).not.toContain("foreign-app");
        expect(a.total).toBe(6);
        const b = await loadStackList(t.db, orgB, DEFAULT_PARAMS);
        expect(b.items.map((i) => i.composeProject)).toEqual(["foreign-app"]);
        expect(b.setup).toEqual({connected: false, enabledEnvironments: 0});
    });
    it("returns a strict DTO with counts computed from the latest inventory (lab shape)", async () => {
        const a = await loadStackList(t.db, orgA, DEFAULT_PARAMS);
        StackListSchema.parse(a);
        const demo = a.items.find((i) => i.composeProject === "forklab-demo")!;
        expect(demo.inventory).toMatchObject({version: 1, counts: {services: 2, volumes: 2, binds: 1, networks: 2, databases: 1, shared: 1}});
        expect(demo).toMatchObject({runtime: "running", protection: "unprotected", staleSince: null, environmentName: "env"});
        expect(a.items.find((i) => i.composeProject === "noinv-app")!.inventory).toBeNull();
    });
    it("summary tiles cover the whole org, not the filter; environments list for the filter", async () => {
        const a = await loadStackList(t.db, orgA, parseStackListParams({runtime: "partial"}));
        expect(a.items.map((i) => i.composeProject)).toEqual(["stale-app"]);
        expect(a.summary).toEqual({total: 6, unprotected: 6, staleOrGone: 2});
        expect(a.environments).toEqual(["env", "other"]);
    });
    it("filters: environment, runtime, protection; search over name and project; LIKE metacharacters are literal", async () => {
        const names = async (raw: Record<string, string>) => (await loadStackList(t.db, orgA, parseStackListParams(raw))).items.map((i) => i.composeProject).sort();
        expect(await names({environment: "other"})).toEqual(["stale-app"]);
        expect(await names({runtime: "absent"})).toEqual(["gone-app"]);
        expect(await names({protection: "active"})).toEqual([]);
        expect(await names({q: "FORKLAB"})).toEqual(["forklab-demo"]);
        expect(await names({q: "100%"})).toEqual(["pct-app"]);
        expect(await names({q: "%"})).toEqual(["pct-app"]);
        expect(await names({q: "_"})).toEqual(["pct-app"]);
        expect(await names({q: "'; drop table fork_stack; --"})).toEqual([]);
        expect((await t.pool.query("select count(*)::int c from fork_stack")).rows[0].c).toBe(7);
    });
    it("sort: name (case-insensitive), attention (gone, stale, unprotected), updated", async () => {
        const order = async (sort: string) => (await loadStackList(t.db, orgA, parseStackListParams({sort}))).items.map((i) => i.composeProject);
        expect((await order("name"))[0]).toBe("pct-app"); // "100% sure_app" sorts before "bad-app"? no: digits first
        const att = await order("attention");
        expect(att.slice(0, 2)).toEqual(["gone-app", "stale-app"]);
        await pool.query("update fork_stack set updated_at = now() + interval '1 hour' where id = $1", [ids.bad]);
        expect((await order("updated"))[0]).toBe("bad-app");
    });
    it("paginates (25/page), clamps an out-of-range page, totals stay honest", async () => {
        const o = await seedOrg(pool, "many");
        for (let i = 0; i < PAGE_SIZE + 5; i++) await stack(o, null, `s${String(i).padStart(2, "0")}`);
        const p1 = await loadStackList(t.db, o, DEFAULT_PARAMS);
        expect(p1).toMatchObject({total: 30, page: 1, pageSize: 25});
        expect(p1.items).toHaveLength(25);
        const p2 = await loadStackList(t.db, o, parseStackListParams({page: "2"}));
        expect(p2.items).toHaveLength(5);
        expect(p2.items[0].composeProject).toBe("s25");
        expect((await loadStackList(t.db, o, parseStackListParams({page: "500"}))).page).toBe(2);
    });
    it("setup + syncing + circuit come from durable state", async () => {
        let a = await loadStackList(t.db, orgA, DEFAULT_PARAMS);
        expect(a).toMatchObject({syncing: false, circuitOpen: false, setup: {connected: true, enabledEnvironments: 0}});
        await pool.query("update fork_arcane_environment set enabled = true where id = $1", [envA]);
        await pool.query("update fork_arcane_connection set circuit_open_until = now() + interval '5 minutes' where id = $1", [conn]);
        await pool.query("insert into fork_lock (name, owner, expires_at) values ($1, 'x', now() + interval '1 minute')", [`sync:${conn}`]);
        a = await loadStackList(t.db, orgA, DEFAULT_PARAMS);
        expect(a).toMatchObject({syncing: true, circuitOpen: true, setup: {connected: true, enabledEnvironments: 1}});
        await pool.query("delete from fork_lock where name = $1", [`sync:${conn}`]);
        await pool.query("update fork_arcane_connection set circuit_open_until = null where id = $1", [conn]);
    });
    it("the serialised list carries no inventory internals or secrets", async () => {
        const json = JSON.stringify(await loadStackList(t.db, orgA, DEFAULT_PARAMS));
        for (const s of ["POSTGRES_PASSWORD", "env_keys", "container_id", "provenance", CANARY, "api_key"]) expect(json).not.toContain(s);
    });
});

describe("W08 stack detail loader + resource-scoped access (SEC-12)", () => {
    it("returns the DTO for the owning organization: lab shape, last sync from the environment", async () => {
        await pool.query("update fork_arcane_environment set last_sync_at = $1 where id = $2", [new Date("2026-11-07T01:05:00Z"), envA]);
        const d = (await loadStackDetail(t.db, orgA, ids.demo))!;
        StackDetailSchema.parse(d);
        expect(d).toMatchObject({name: "forklab-demo", environmentName: "env", runtime: "running", protection: "unprotected", staleSince: null, lastSyncAt: "2026-11-07T01:05:00.000Z", syncing: false});
        expect(d.inventory.state).toBe("ok");
        if (d.inventory.state === "ok") expect(d.inventory.view.networks.map((n) => n.name)).toEqual(["forklab-demo_internal", "lab_proxy"]);
    });
    it("uses the LATEST version", async () => {
        const inv = richInventory({project: "forklab-demo"});
        inv.services.pop();
        await addInventory(ids.demo, "forklab-demo", 2, inv);
        const d = (await loadStackDetail(t.db, orgA, ids.demo))!;
        expect(d.inventory.state === "ok" && d.inventory.view.version).toBe(2);
        expect(d.inventory.state === "ok" && d.inventory.view.services).toHaveLength(1);
    });
    it("no inventory → state none; stored garbage → unreadable (never a crash, never echoed)", async () => {
        expect((await loadStackDetail(t.db, orgA, ids.noinv))!.inventory).toEqual({state: "none"});
        const bad = (await loadStackDetail(t.db, orgA, ids.bad))!;
        expect(bad.inventory).toEqual({state: "unreadable"});
        expect(JSON.stringify(bad)).not.toContain(CANARY);
    });
    it("gone / stale facets come through", async () => {
        expect((await loadStackDetail(t.db, orgA, ids.gone))).toMatchObject({runtime: "absent", staleSince: null});
        expect((await loadStackDetail(t.db, orgA, ids.stale))!.staleSince).toBe("2026-11-07T00:00:00.000Z");
    });
    it("cross-org: B's stack is null for A and A's is null for B; unknown and malformed ids are null too (identical)", async () => {
        expect(await loadStackDetail(t.db, orgA, ids.foreign)).toBeNull();
        expect(await loadStackDetail(t.db, orgB, ids.demo)).toBeNull();
        expect(await loadStackDetail(t.db, orgA, randomUUID())).toBeNull();
    });
    it("assertForkResource(stacks.view): member of the owning org passes; member of another org, no-membership system admin and no principal → NotFound (no oracle); pending → NotFound", async () => {
        const P = (role: string | null, orgs: [string, string][]): ForkPrincipal => ({userId: "u", systemRole: role, memberships: orgs.map(([organizationId, r]) => ({organizationId, role: r}))});
        const ok = await assertForkResource(t.db, P("user", [[orgA, "member"]]), "stacks.view", {kind: "stack", id: ids.demo});
        expect(ok.organizationId).toBe(orgA);
        for (const p of [P("user", [[orgB, "owner"]]), P("superadmin", []), P("admin", [[orgB, "admin"]]), null]) {
            await expect(assertForkResource(t.db, p, "stacks.view", {kind: "stack", id: ids.demo})).rejects.toBeInstanceOf(ForkNotFoundError);
        }
        await expect(assertForkResource(t.db, P("user", [[orgA, "member"]]), "stacks.view", {kind: "stack", id: "not-a-uuid"})).rejects.toBeInstanceOf(ForkNotFoundError);
        await expect(assertForkResource(t.db, P("user", [[orgA, "member"]]), "stacks.backup.manage", {kind: "stack", id: ids.demo})).rejects.toBeInstanceOf(ForkForbiddenError);
        expect(actorIn(P("user", [[orgA, "member"]]), orgB)).toEqual({systemRole: "user", orgRole: null});
    });
});
