import {randomUUID} from "node:crypto";
import {eq} from "drizzle-orm";
import type {Pool} from "pg";
import type {ForkPrincipal} from "@/fork/acl";
import {leaseTask, submitResult} from "@/fork/agent-channel/tasks";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import {buildManifest} from "@/fork/manifest/build";
import {signManifest} from "@/fork/manifest/sign";
import {RULES_SHA256} from "@/fork/policy/rules";
import {resetRateLimits} from "@/fork/net/rate-limit";
import type {RestoreRunDeps} from "@/fork/restore-run/deps";
import {tickRestoreRun} from "@/fork/restore-run/tick";
import {submitRender} from "@/fork/restore-tasks/render";
import {blankPolicyView} from "@/fork/restore-tasks/view";
import {createHash} from "node:crypto";
import type {W04Db} from "@/fork/__tests__/w04-helpers";
import type {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {P, req, seedUser} from "@/fork/__tests__/w16-world";
import {approveRestorePlan, createRestorePlan, deps as chDeps, type W17} from "@/fork/__tests__/w17-world";

/**
 * W18a test harness: a fake agent made of the REAL channel functions (`leaseTask`, `submitRender`, `submitResult`), a controllable clock that starts at the REAL
 * clock (never a fixed past date mixed with DB `now()`), and the services' deps with seams for the manifest and the artifact URLs.
 */
export const CAPS = ["channel.v1", "noop.v1", "restore.target.v1", "compose.render.v1", "test-restore.v1"];
export const DOC = {name: "app", services: {web: {image: "nginx:1", environment: {A: "x"}, networks: {default: null}}, db: {image: "postgres:17", networks: {default: null}}}, networks: {default: {name: "app_default"}}};
export type Reply = {status?: "succeeded" | "failed" | "rejected"; reason?: string; result?: Record<string, unknown>; doc?: unknown};
export type Key = ReturnType<typeof testKeypair>;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function harness(t: W04Db, kek: string, key: Key, org: string) {
    const pool: Pool = t.pool;
    const T0 = new Date();
    const clock = {ms: T0.getTime()};
    const now = () => new Date(clock.ms);
    const advance = (ms: number) => { clock.ms += ms; };
    const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
    const principals = new Map<string, ForkPrincipal>();
    const user = async (role: "admin" | "owner" | "member" | "sys"): Promise<ForkPrincipal> => {
        const id = await seedUser(pool, role === "sys" ? "admin" : "user");
        const p: ForkPrincipal = role === "sys" ? {userId: id, systemRole: "admin", memberships: []} : {userId: id, systemRole: "user", memberships: [{organizationId: org, role}]};
        principals.set(id, p);
        return p;
    };
    const enr = async (agentId: string) => (await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId)))[0]!;

    /** service deps as `p`; the tick resolves the starter through `principalOf` (so a test can demote / ban the starter). */
    const deps = (w: W17, p: ForkPrincipal | null, over: Partial<RestoreRunDeps> = {}): RestoreRunDeps => {
        const {principal: _p, ...ch} = chDeps(t, kek, key, p?.userId ?? null, {now});
        return {...ch, principal: p, artifactUrl: async (id) => `https://lab.invalid/${id}`, manifest: async () => ({json: w.manifestJson, sigB64: w.manifestSig}),
            principalOf: async (id) => { const x = principals.get(id); return x ? {kind: "ok", principal: x} : {kind: "missing"}; }, ...over};
    };

    const plan = async (w: W17, o: {select?: string[]; mode?: "new_stack" | "selective"; purpose?: "restore" | "test_restore"; approve?: boolean; mappings?: Record<string, unknown>} = {}) => {
        const sys = await user("sys");
        const creator = await user("admin");
        const c = await createRestorePlan({db: t.db, principal: P(creator.userId, "user", [org, "admin"]), configAllowed: async () => true, now}, req(w, {
            mode: o.mode ?? "new_stack", purpose: o.purpose ?? "restore",
            mappings: {target_project: null, restore_root: "/srv/restore", volumes: null, select: o.select ?? ["dir:/srv/app", "volume:app_data", "db:db"], sqlite: null, ...o.mappings}}));
        if (!c.ok) throw new Error(`plan refused: ${c.code}`);
        if (o.approve !== false) for (const kind of ["production_target", "destructive_replace"] as const) await approveRestorePlan({db: t.db, principal: P(sys.userId, "admin"), configAllowed: async () => true, now}, {planId: c.planId, planHash: c.planHash, kind});
        return c;
    };

    const defaults = (type: string, w: W17, rpSeq: number): Reply => {
        switch (type) {
            case "restore_probe": return {result: {roots: [{path: "/srv/restore", shared: true, free_bytes: 1e12}], workspace_state: "absent", arch: "x86_64", compose_version: "5.4.0", rules_sha256: RULES_SHA256}};
            case "restore_stage": return {result: {staged: [], extracted: [], manifest_sequence: rpSeq, kid: w.key.kid}};
            case "restore_apply": return {result: {volumes: []}};
            case "compose_render": return {result: {rendered: true}, doc: DOC};
            case "restore_db": return {result: {dbs: [{service: "db", format: "pg_custom", status: "restored"}]}};
            case "compose_up": return {result: {project: "app", services: [{service: "web", state: "running"}, {service: "db", state: "running"}]}};
            case "restore_cleanup": return {result: {removed: 1, kept_foreign: 0}};
            case "restore_verify": return {result: {checks: [{index: 0, engine: "postgresql", status: "ok"}], seconds: 1}}; // W-TR
            default: return {};
        }
    };

    /** The fake agent: leases the next task of `w.agent` and answers it. `script[type]` overrides the default reply; `lapse` leases without answering. */
    const agentStep = async (w: W17, script: Record<string, Reply | undefined> = {}, o: {lapse?: boolean} = {}): Promise<{type: string; taskId: string} | null> => {
        const e = await enr(w.agent);
        const l = await leaseTask(t.db, e, {capabilities: CAPS, leaseSeconds: 60, now: now()});
        if (!l) return null;
        const type = JSON.parse(l.envelope).type as string;
        if (o.lapse) return {type, taskId: l.task_id};
        const rpSeq = Number((await q("select sequence from fork_recovery_point where id=$1", [w.rp]))[0].sequence);
        const reply = {...defaults(type, w, rpSeq), ...(script[type] ?? {})};
        if (type === "compose_render" && (reply.status ?? "succeeded") === "succeeded") {
            const view = Buffer.from(JSON.stringify(blankPolicyView(reply.doc ?? DOC)));
            const r = await submitRender(t.db, e, {taskId: l.task_id, organizationId: org, now: now(), body: {lease_id: l.lease_id, restore_id: await restoreIdOf(l.task_id), view_b64: view.toString("base64"), view_sha256: sha(view),
                raw: {refused: false, violations: [], reason: null}, roots: ["/srv/restore/app"], files: ["compose.yml"], compose_version: "5.4.0", rules_sha256: RULES_SHA256}});
            if (!r.ok) throw new Error(`submitRender: ${r.code}`);
        }
        const r = await submitResult(t.db, e, {taskId: l.task_id, organizationId: org, now: now(), body: {lease_id: l.lease_id, status: reply.status ?? "succeeded", ...(reply.reason ? {reason: reply.reason} : {}), ...(reply.result ? {result: reply.result} : {})}});
        if (!r.ok) throw new Error(`submitResult: ${r.code}`);
        return {type, taskId: l.task_id};
    };
    /** restore id of a task = the run whose journal references it (set by the enqueue transaction) */
    const restoreIdOf = async (taskId: string) => (await q("select run_id from fork_restore_run_task where task_id=$1", [taskId]))[0].run_id as string;

    const run = async (id: string) => (await q("select * from fork_restore_run where id=$1", [id]))[0]!;
    const journal = (id: string) => q("select * from fork_restore_run_task where run_id=$1 order by created_at, attempt", [id]);
    const tasks = (agentId: string) => q("select id, type, status, attempts, payload_enc is null as purged from fork_agent_task where agent_id=$1 order by seq", [agentId]);
    const tick = (d: RestoreRunDeps, id: string) => tickRestoreRun(d, id);

    /** tick → fake agent → tick … until the run is terminal (or `max` rounds). */
    const drive = async (d: RestoreRunDeps, w: W17, runId: string, script: Record<string, Reply | undefined> = {}, max = 40) => {
        for (let i = 0; i < max; i++) {
            await tick(d, runId);
            const r = await run(runId);
            if (!["running", "awaiting_approval"].includes(r.state)) return r;
            if (r.state === "awaiting_approval") return r;
            await agentStep(w, script);
        }
        return run(runId);
    };

    /** a validly signed manifest of the SAME stack/RP id but another sequence (rollback fixture) */
    const signedManifestOf = async (w: W17, sequence: number) => {
        if (sequence < 1) throw new Error("manifest sequence starts at 1");
        const rp = (await q("select * from fork_recovery_point where id=$1", [w.rp]))[0];
        const arts = await q("select * from fork_recovery_point_artifact where rp_id=$1 order by source_name", [w.rp]);
        const facts = arts.map((a) => ({sourceName: a.source_name, engine: a.engine, archiveKind: a.archive_kind, dumpFormat: a.dump_format, archiveFormatVersion: a.archive_format_version, encrypted: a.encrypted, channelId: a.channel_id, channelKind: a.channel_kind,
            pathOrSnapshotId: a.path_or_snapshot_id, generatedId: a.generated_id, sizeBytes: a.size_bytes === null ? null : Number(a.size_bytes), ciphertextSha256: a.ciphertext_sha256, plaintextSha256: a.plaintext_sha256, plaintextSize: a.plaintext_size === null ? null : Number(a.plaintext_size), required: a.required}));
        const m = buildManifest({id: w.rp, stackId: w.stack, stackName: "app", sequence, createdAt: rp.created_at, finalizedAt: rp.created_at, consistencyLevel: "mixed", inventoryVersion: 1, inventoryHash: rp.inventory_hash, requiredArtifactCount: 3}, facts, null,
            {kid: key.kid, signedAt: T0, verifiedAt: T0});
        const s = signManifest(m, key.privateKey);
        return {json: s.json, sigB64: s.sig.toString("base64")};
    };

    const start = async (d: RestoreRunDeps, c: {planId: string; planHash: string}, extra: Record<string, unknown> = {}) => {
        const {startRestoreRun} = await import("@/fork/restore-run/service");
        return startRestoreRun(d, {planId: c.planId, planHash: c.planHash, confirm: "RESTORE app", acceptMissingInputs: true, ...extra});
    };

    return {principals, T0, now, advance, q, user, deps, plan, agentStep, drive, run, journal, tasks, tick, start, enr, signedManifestOf, reset: () => resetRateLimits(), randomUUID};
}
export type Harness = ReturnType<typeof harness>;
