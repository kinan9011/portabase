import {randomBytes, randomUUID} from "node:crypto";
import {mkdtempSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {drizzle} from "drizzle-orm/node-postgres";
import {afterAll, describe, expect, it} from "vitest";
import {type App, boot, get, signIn} from "@/fork/__tests__/e2e/helpers";
import {assertNoCanary, findCanary, makeCanaries} from "@/fork/__tests__/security/canary";
import {P, req, seedWorld} from "@/fork/__tests__/w16-world";
import {setRestoreOverrides} from "@/fork/config/service";
import {insertConnectionWithSecret} from "@/fork/db/dto";
import type {ForkDb} from "@/fork/db/handle";
import {defaultKekDir} from "@/fork/kek";
import {createRestorePlan} from "@/fork/restore/service";

/**
 * SEC-09 browser-side canary sweep (plan D-9, e2e tier) on the REAL production build: every fork page (HTML and the RSC flight payload, which is what a browser really receives),
 * the diagnostic API route and the server log, for a signed-in system administrator. Canaries: Arcane key (encrypted connection), storage secret (upstream channel config),
 * restore-override values (encrypted) and an enrolment credential hash (the pin fingerprint is public by design). NONE may appear in any form (raw / base64 / base64url / hex / URL-encoded).
 * Behavioural page coverage (roles, IDOR, flags-off 404) stays in w06 / w08 / wtr-panel / w18b (cited in security/matrix.ts PAGE_MATRIX).
 */
const c = makeCanaries();
c.agentSecret = randomBytes(32).toString("hex"); // the credential_hash column is a 64-hex check constraint
c.labelValue = `CANARY_LABEL_${randomBytes(8).toString("hex")}`; // (the pin FINGERPRINT is public by design — shown on the agent-channel page — so it is not a canary)
let first: App | undefined; let second: App | undefined;
afterAll(async () => { await second?.stop(); await first?.stop(); await first?.db.drop().catch(() => {}); });

describe("SEC-09 pages canary (real build)", () => {
    it("no planted secret reaches any fork page (HTML + RSC), /api/fork/status or the server log", async () => {
        const priv = mkdtempSync(path.join(os.tmpdir(), "w27-priv-"));
        const flags = {FORK_STACKS_ENABLED: "true", FORK_ARCANE_ENABLED: "true", AUTH_SIGNUP_ENABLED: "false", PRIVATE_PATH: priv};
        first = await boot({PRIVATE_PATH: priv}, [], undefined, true);
        const pool = first.db.pool;
        const q = (s: string, p: unknown[] = []) => pool.query(s, p);
        const db = drizzle({client: pool}) as unknown as ForkDb;
        const org = (await q("select id from organization where deleted_at is null")).rows[0].id as string;
        const w = await seedWorld(pool, {org, hostRole: "production", roots: ["/srv"]});
        await insertConnectionWithSecret(db, {organizationId: org, name: "arcane-sec", baseUrl: "http://127.0.0.1:9", apiKey: `arc_FAKEPFX1_${c.arcaneKey}`}, defaultKekDir(priv));
        await q("update storage_channel set config=$2 where organization_id=$1", [org, JSON.stringify({endpoint: "https://s3.example.test", accessKey: "AKIASWEEP", secretKey: c.storageSecret})]);
        await q("update fork_agent_enrollment set credential_hash=$2 where agent_id=$1", [w.agent, c.agentSecret]);
        const plan = await createRestorePlan({db, principal: P(randomUUID(), "user", [org, "admin"]), configAllowed: async () => true}, req(w, {mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: null, sqlite: null}}));
        if (!plan.ok) throw new Error(`plan refused: ${plan.code}`);
        const ov = await setRestoreOverrides({db, principal: P(randomUUID(), "user", [org, "admin"]), kekDir: defaultKekDir(priv), configAllowed: async () => true}, {planId: plan.planId, planHash: plan.planHash, set: [{service: "web", key: "A", value: c.envValue}]});
        expect(ov.ok, JSON.stringify(ov)).toBe(true);
        const runId = randomUUID();
        await q(`insert into fork_restore_run (id, organization_id, stack_id, plan_id, plan_hash, rp_id, rp_sequence, target_agent_id, target_agent_name, purpose, mode, state, reason, failed_step, steps, confirmation, started_by, created_at, deadline_at, finished_at, updated_at)
                 values ($1,$2,$3,$4,$5,$6,1,$7,$8,'restore','new_stack','failed','artifact_unavailable','stage','[]','typed','u', now() - interval '1 hour', now() + interval '11 hours', now(), now())`,
            [runId, org, w.stack, plan.planId, plan.planHash, w.rp, w.agent, w.agentName]);
        await first.stop();

        second = await boot(flags, [], first.db);
        const base = second.base;
        const admin = await signIn(base);
        const pages = ["/dashboard/integrations", "/dashboard/integrations/agent-channel", "/dashboard/integrations/recovery-kit", "/dashboard/stacks", `/dashboard/stacks/${w.stack}`, `/dashboard/stacks/${w.stack}/configure`,
            "/dashboard/recovery", "/dashboard/recovery/new", `/dashboard/recovery/new?step=backup&stack=${w.stack}`, `/dashboard/recovery/plans/${plan.planId}`, `/dashboard/recovery/runs/${runId}`];
        const rsc = (p: string) => fetch(`${base}${p}`, {headers: {cookie: admin, RSC: "1"}}).then((r) => r.text());
        const leaks: string[] = [];
        for (const p of pages) {
            const r = await get(base, p, admin);
            expect(r.status, `${p} (the admin sees every fork page)`).toBe(200);
            for (const [kind, body] of [["html", await r.text()], ["rsc", await rsc(p)], ["rsc-q", await rsc(`${p}${p.includes("?") ? "&" : "?"}_rsc=1`)]] as const) {
                const hits = findCanary(body, c);
                if (hits.length) leaks.push(`${p} [${kind}]: ${hits.join(", ")}`);
                expect(body.includes(priv), `${p} [${kind}] leaks the private path`).toBe(false);
            }
        }
        for (const p of ["/dashboard/recovery/plans", "/dashboard/recovery/runs"]) { // W27a P0 breadcrumb index routes: sent to the recovery home (HTTP 307, or the streamed meta refresh when the segment's loading boundary already flushed)
            const r = await get(base, p, admin);
            const html = await r.text();
            expect(r.status === 307 ? new URL(r.headers.get("location") ?? "", base).pathname : /http-equiv="refresh"[^>]*url=\/dashboard\/recovery"/.test(html) ? "/dashboard/recovery" : `${r.status}:${html.slice(0, 80)}`, p).toBe("/dashboard/recovery");
        }
        const st = await get(base, "/api/fork/status", admin);
        expect(st.status).toBe(200);
        const stBody = await st.text();
        if (findCanary(stBody, c).length) leaks.push(`/api/fork/status: ${findCanary(stBody, c).join(", ")}`);
        expect(leaks, leaks.join("\n")).toEqual([]);
        assertNoCanary(second.logs(), c, "the server log");
    }, 300_000);
});
