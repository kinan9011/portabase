import {randomBytes, randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, describe, expect, it} from "vitest";
import {type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {P, req, seedWorld, type World} from "@/fork/__tests__/w16-world";
import {setRestoreOverrides} from "@/fork/config/service";
import type {ForkDb} from "@/fork/db/handle";
import {defaultKekDir} from "@/fork/kek";
import {createRestorePlan} from "@/fork/restore/service";

/**
 * W18b e2e on the REAL production build (no agents, no lab): the four recovery pages over HTTP with the real proxy, real session and real boot sequence.
 * Canaries: an override value (stored KEK-encrypted by the W16b service), a host path inside a plan action, enrolment secrets: none may appear in the page HTML or in the RSC payload.
 */
const MEMBER = {email: "member@w18b.test", password: "W18b-member-Password!1", name: "Member"};
const ORGADMIN = {email: "orgadmin@w18b.test", password: "W18b-orgadmin-Password!1", name: "Org Admin"};
const CANARY_VALUE = `CANARY_VALUE_${randomBytes(12).toString("hex")}`;
const CANARY_CRED = randomBytes(32).toString("hex");
const CANARY_PIN = `CANARY_PIN_${randomBytes(8).toString("hex")}`;
const ORIGINAL_PATH = "/srv/app"; // the compose working dir of the seeded stack: it is the `source.original_path` of the plan's compose action and must never reach the client
const GONE = "That choice is no longer available";

const login = async (base: string, u: {email: string; password: string}) => {
    const r = await fetch(`${base}/api/auth/sign-in/email`, {method: "POST", headers: {"content-type": "application/json", origin: base}, body: JSON.stringify({email: u.email, password: u.password})});
    expect(r.status, await r.clone().text()).toBe(200);
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};
const rsc = (base: string, p: string, cookie: string) => fetch(`${base}${p}`, {headers: {cookie, RSC: "1"}}).then((r) => r.text());
/** the visible text of a page: tags and scripts stripped */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

let first: App | undefined; let second: App | undefined;
afterAll(async () => { await second?.stop(); await first?.stop(); await first?.db.drop().catch(() => {}); });

describe("W18b recovery pages (real build)", () => {
    it("pages render, nothing secret leaks (HTML + RSC), no existence oracle, member/admin roles, flags off ⇒ real 404", async () => {
        const priv = mkdtempSync(path.join(os.tmpdir(), "w18b-priv-"));
        const flags = {FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false", PRIVATE_PATH: priv}; // D21 self-check: sign-up must be off
        // ---- boot 1 (flags off): create the database, the default org + admin and two plain accounts
        first = await boot({PRIVATE_PATH: priv}, [], undefined, true);
        for (const u of [MEMBER, ORGADMIN]) {
            const up = await fetch(`${first.base}/api/auth/sign-up/email`, {method: "POST", headers: {"content-type": "application/json", origin: first.base}, body: JSON.stringify(u)});
            expect(up.status, await up.clone().text()).toBeLessThan(300);
            await first.db.pool.query(`update "user" set role = 'user' where email = $1`, [u.email]);
        }
        const flagsOff = await signIn(first.base);
        for (const p of ["/dashboard/recovery", "/dashboard/recovery/new", `/dashboard/recovery/plans/${randomUUID()}`, `/dashboard/recovery/runs/${randomUUID()}`]) expect((await get(first.base, p, flagsOff)).status, p).toBe(404); // E5
        expect(await (await get(first.base, "/dashboard/home", flagsOff)).text()).not.toMatch(/\/dashboard\/recovery/);

        // ---- seed (fork lane exists even with flags off)
        const pool = first.db.pool;
        const q = (s: string, p: unknown[] = []) => pool.query(s, p);
        const db = drizzle({client: pool}) as unknown as ForkDb;
        const org = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const userId = async (email: string) => (await q(`select id from "user" where email = $1`, [email])).rows[0].id as string;
        const [memberId, orgAdminId] = [await userId(MEMBER.email), await userId(ORGADMIN.email)];
        await q(`delete from member where user_id in ($1,$2)`, [memberId, orgAdminId]);
        await q("insert into member (organization_id, user_id, role) values ($1,$2,'member'), ($1,$3,'admin')", [org, memberId, orgAdminId]);
        const foreignOrg = (await q("insert into organization (name, slug, deleted_at) values ('Gone Org','gone-org', now()) returning id")).rows[0].id as string; // soft-deleted: keeps the single-tenant self-check green
        const w: World = await seedWorld(pool, {org, hostRole: "production", roots: ["/srv"]});
        const fw: World = await seedWorld(pool, {org: foreignOrg, hostRole: "production", roots: ["/srv"]});
        await q("update fork_agent_enrollment set credential_hash=$2, pin_fingerprint=$3 where agent_id=$1", [w.agent, CANARY_CRED, CANARY_PIN]);
        const adminOf = (o: string) => P(randomUUID(), "user", [o, "admin"]);
        const mkPlan = async (world: World, o: string) => {
            const c = await createRestorePlan({db, principal: adminOf(o), configAllowed: async () => true}, req(world, {mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: null, sqlite: null}}));
            if (!c.ok) throw new Error(`plan refused: ${c.code}`);
            return c;
        };
        const planA = await mkPlan(w, org);
        const planInfo = (await q("select outcome, plan->'blockers' as b, plan->'actions' as a from fork_restore_plan where id=$1", [planA.planId])).rows[0];
        expect(planInfo.outcome, JSON.stringify([planInfo.b, planInfo.a.map((x: {kind: string; op: string; reasons: string[]}) => [x.kind, x.op, x.reasons])])).toBe("ready");
        expect(JSON.stringify(planInfo.a), "the canary host path really is in the stored plan").toContain(ORIGINAL_PATH);
        const planB = await mkPlan(w, org);
        const foreignPlan = await mkPlan(fw, foreignOrg);
        const ov = await setRestoreOverrides({db, principal: adminOf(org), kekDir: defaultKekDir(priv), configAllowed: async () => true}, {planId: planA.planId, planHash: planA.planHash, set: [{service: "web", key: "A", value: CANARY_VALUE}]});
        expect(ov.ok, JSON.stringify(ov)).toBe(true);
        const mkRun = async (planId: string, planHash: string, world: World, o: string, state: string, reason: string | null, steps: unknown[]) => {
            const id = randomUUID();
            await q(`insert into fork_restore_run (id, organization_id, stack_id, plan_id, plan_hash, rp_id, rp_sequence, target_agent_id, target_agent_name, purpose, mode, state, reason, failed_step, steps, confirmation, started_by, created_at, deadline_at, finished_at, updated_at)
                     values ($1,$2,$3,$4,$5,$6,1,$7,$8,'restore','new_stack',$9,$10,$11,$12,'typed','u', now() - interval '1 hour', now() + interval '11 hours', now(), now())`,
                [id, o, world.stack, planId, planHash, world.rp, world.agent, world.agentName, state, reason, reason ? "stage" : null, JSON.stringify(steps)]);
            return id;
        };
        const runB = await mkRun(planB.planId, planB.planHash, w, org, "failed", "artifact_unavailable", [{name: "verify_manifest", status: "done", attempts: 1, errors: 0}, {name: "probe", status: "done", attempts: 1, errors: 0}, {name: "stage", status: "failed", attempts: 1, errors: 0, code: "artifact_unavailable"}, {name: "apply", status: "failed", attempts: 0, errors: 0}]);
        const foreignRun = await mkRun(foreignPlan.planId, foreignPlan.planHash, fw, foreignOrg, "failed", "stale", [{name: "verify_manifest", status: "failed", attempts: 1, errors: 0, code: "stale"}]);
        // D21 self-check (C3/C4): fork rows may not reference an agent / channel bound to ANOTHER organization, or the instance locks. Org-less is allowed, so un-bind the foreign world now that its plan + run exist.
        await q("update agents set organization_id = null where id = $1", [fw.agent]);
        await q("update storage_channel set organization_id = null where organization_id = $1", [foreignOrg]);
        const live = (await q("select o.id, o.slug, (select string_agg(u.email || ':' || m.role, ',') from member m join \"user\" u on u.id = m.user_id where m.organization_id = o.id) as members from organization o where o.deleted_at is null")).rows;
        expect(live.length, JSON.stringify(live)).toBe(1);
        await first.stop(); // keepDb: the database survives for boot 2

        // ---- boot 2: flags on, same database
        second = await boot(flags, [], first.db);
        const base = second.base;
        const admin = await signIn(base);
        const memberCk = await login(base, MEMBER);
        const orgAdminCk = await login(base, ORGADMIN);
        const pages = [
            ["/dashboard/recovery", "Stack Recovery"],
            ["/dashboard/recovery/new", "Which app do you want back?"],
            [`/dashboard/recovery/new?step=backup&stack=${w.stack}`, "Which backup?"],
            [`/dashboard/recovery/new?step=machine&stack=${w.stack}&point=1`, "Which machine should run it?"],
            [`/dashboard/recovery/plans/${planA.planId}`, "Here is what will happen"],
            [`/dashboard/recovery/runs/${runB}`, "Restoring"],
        ] as const;

        // E1 pages + sidebar
        for (const [p, title] of pages) {
            const r = await get(base, p, admin);
            expect(r.status, p).toBe(200);
            const html = await r.text();
            const body = html.slice(html.indexOf('<main class="h-full">')); // the page itself (the <title> also carries the name, so it proves nothing)
            expect(body.includes('NEXT_HTTP_ERROR_FALLBACK'), `${p} rendered not-found: ${second!.logs().split('\n').filter((l) => /fork\/init|self-check|locked/i.test(l)).join(' | ').slice(-900)}`).toBe(false);
            expect(visible(body), p).toContain(title);
        }
        expect(await (await get(base, "/dashboard/home", admin)).text()).toContain('href="/dashboard/recovery"');

        // E2 canary: HTML and RSC payload of every page (admin session), plus the plan's override view
        const all = [...pages.map(([p]) => p)];
        for (const p of all) {
            for (const body of [await (await get(base, p, admin)).text(), await rsc(base, p, admin), await rsc(base, `${p}${p.includes("?") ? "&" : "?"}_rsc=1`, admin)]) {
                for (const c of [CANARY_VALUE, CANARY_CRED, CANARY_PIN, ORIGINAL_PATH]) expect(body.includes(c), `${p} leaks ${c.slice(0, 12)}`).toBe(false);
                expect(body.includes(priv), `${p} leaks the private path`).toBe(false);
            }
        }
        // the plan page shows the override as a NAME in a state, never its value
        expect(visible(await (await get(base, `/dashboard/recovery/plans/${planA.planId}`, admin)).text())).toContain("Before the restore can start");

        // E3 no existence oracle: random and foreign ids show the same visible content; a foreign stack in the wizard is dropped with the same sentence
        const ghost = async (p: string) => { const h = await (await get(base, p, admin)).text(); const body = h.slice(h.indexOf('<main class="h-full">')); return `${body.includes("NEXT_HTTP_ERROR_FALLBACK")}|${visible(body)}`; }; // page body only (the head carries request-specific ids); the not-found marker must match too
        // streamed Suspense chunks arrive in any order (CI 42458182951): compare the words, not their order
        const words = (g: string) => g.split(" ").sort().join(" ");
        const randomPlan = await ghost(`/dashboard/recovery/plans/${randomUUID()}`);
        expect(words(await ghost(`/dashboard/recovery/plans/${foreignPlan.planId}`))).toBe(words(randomPlan));
        const randomRun = await ghost(`/dashboard/recovery/runs/${randomUUID()}`);
        expect(words(await ghost(`/dashboard/recovery/runs/${foreignRun}`))).toBe(words(randomRun));
        expect(await ghost(`/dashboard/recovery/new?stack=${fw.stack}`)).toContain(GONE);
        expect(await ghost(`/dashboard/recovery/new?stack=${randomUUID()}`)).toContain(GONE);
        expect(randomPlan).not.toContain(planA.planId);
        expect(randomPlan.startsWith("true|"), "random id ⇒ the not-found page").toBe(true);

        // E4 roles: a member sees the page without Restores and the R-role text on /new; an org admin who is not owner cannot confirm a production restore
        const mHome = visible(await (await get(base, "/dashboard/recovery", memberCk)).text());
        expect(mHome).toContain("Stack Recovery");
        expect(mHome).not.toContain("No restore has been started yet");
        expect(visible(await (await get(base, "/dashboard/recovery/new", memberCk)).text())).toContain("Restoring is limited to organization admins");
        expect(await (await get(base, "/dashboard/home", memberCk)).text()).toContain('href="/dashboard/recovery"');
        const aPlan = await get(base, `/dashboard/recovery/plans/${planA.planId}`, orgAdminCk);
        const aHtml = await aPlan.text();
        expect(visible(aHtml)).toContain("Only the organization owner or a system administrator can confirm a restore to a production machine");
        expect(/data-testid="go-button"[^>]*aria-disabled="true"/.test(aHtml) || /aria-disabled="true"[^>]*data-testid="go-button"/.test(aHtml)).toBe(true);
    }, 900_000);
});
