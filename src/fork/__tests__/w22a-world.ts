import {createHash, randomUUID} from "node:crypto";
import {eq} from "drizzle-orm";
import type {Pool} from "pg";
import type {ForkPrincipal} from "@/fork/acl";
import {loadTaskKey} from "@/fork/agent-channel/admin";
import {authenticateAgent} from "@/fork/agent-channel/auth";
import {decodeBundle} from "@/fork/agent-channel/bundle";
import {decryptPayload} from "@/fork/agent-channel/payload";
import {leaseTask, submitResult} from "@/fork/agent-channel/tasks";
import {enrolAgent} from "@/fork/agent-channel/admin";
import {forkAgentEnrollment} from "@/fork/db/schema/agent-channel";
import type {MirrorDeps} from "@/fork/mirror/deps";
import {setRunnerTargets} from "@/fork/runner/service";
import {RULES_SHA256} from "@/fork/policy/rules";
import {submitRender} from "@/fork/restore-tasks/render";
import {blankPolicyView} from "@/fork/restore-tasks/view";
import {resetRateLimits} from "@/fork/net/rate-limit";
import {tickAllMirrors} from "@/fork/mirror/tick";
import {freshForkDb, seedAgent, type W04Db} from "@/fork/__tests__/w04-helpers";
import {CANARY, labFull, WS as LAB_WS} from "@/fork/__tests__/fixtures/compose-compiler/lab";
import {finalViewOf} from "@/fork/__tests__/w22a-final-view";
import {testKeypair} from "@/fork/__tests__/w14-fixtures";
import {seedUser} from "@/fork/__tests__/w16-world";
import {adminUser, deps as chDeps, newKek, PASSWORD, seedW17World, type W17} from "@/fork/__tests__/w17-world";
import type {compileMirror} from "@/fork/compose-compiler/compile";

/**
 * W22a test world: a real Postgres, a plannable stack (verified RP, REAL signed manifest, compose + volume + pg dump artifacts), a designated + enrolled RUNNER (runner.v1 + mirror.v1, one admin
 * probe target), and a FAKE RUNNER made of the REAL channel functions (`leaseTask`, `submitRender`, `submitResult`): it decrypts each task payload and answers it. The clock starts at the REAL clock.
 */
export const RUNNER_CAPS = ["channel.v1", "channel-maint.v1", "noop.v1", "runner.v1", "mirror.v1"];
export const CAN = CANARY;
type Doc = Record<string, any>; // biome-ignore lint/suspicious/noExplicitAny: compose JSON
export type Runner = {agentId: string; credential: string; name: string};
export type Reply = {status?: "succeeded" | "failed" | "rejected"; reason?: string; result?: Record<string, unknown>; finalMutate?: (v: Doc) => void; probeOutcome?: "blocked" | "reachable"; sourceDoc?: Doc};
export type Script = Partial<Record<string, Reply | ((payload: Doc) => Reply)>>;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export async function mirrorWorld() {
    const t: W04Db = await freshForkDb();
    const pool: Pool = t.pool;
    const kek = newKek();
    const key = testKeypair();
    const T0 = Date.now();
    const clock = {ms: T0};
    const now = () => new Date(clock.ms);
    const advance = (ms: number) => { clock.ms += ms; };
    const q = async (s: string, a: unknown[] = []) => (await pool.query(s, a)).rows as Record<string, any>[];
    const adminId = await adminUser(pool);
    const org = (await q("insert into organization (id, name, slug, created_at) values ($1,'org-w22a',$2,now()) returning id", [randomUUID(), `s-${randomUUID().slice(0, 8)}`]))[0].id as string;
    const otherOrg = (await q("insert into organization (id, name, slug, created_at) values ($1,'org-other',$2,now()) returning id", [randomUUID(), `s-${randomUUID().slice(0, 8)}`]))[0].id as string;
    const principals = new Map<string, ForkPrincipal>();
    const user = async (role: "sys" | "admin" | "member", organizationId = org): Promise<ForkPrincipal> => {
        const id = await seedUser(pool, role === "sys" ? "admin" : "user");
        const p: ForkPrincipal = role === "sys" ? {userId: id, systemRole: "admin", memberships: [{organizationId, role: "admin"}]} : {userId: id, systemRole: "user", memberships: [{organizationId, role}]};
        principals.set(id, p);
        return p;
    };
    const resolve = async (h: string) => (h === "mail.prod.example" ? ["10.20.30.25"] : ["10.20.30.1"]);
    const flag = {on: true};
    const channelDeps = (userId: string | null) => chDeps(t, kek, key, userId, {role: "admin", now});

    /** a stack world: verified RP + real signed manifest + compose/volume/pg-dump artifacts. `personal` sets `contains_personal_data`. */
    const world = async (personal: boolean | null = false): Promise<W17> => {
        const w = await seedW17World(t, kek, key, adminId, {org, hostRole: "production"});
        await q("update fork_stack set contains_personal_data=$2 where id=$1", [w.stack, personal]);
        return w;
    };

    /** a designated, enrolled runner with one admin probe target and a fresh ISOLATED probe */
    const runner = async (o: {isolated?: boolean; caps?: string[]; targets?: boolean} = {}): Promise<Runner> => {
        const agentId = await seedAgent(pool, org, `runner-${randomUUID().slice(0, 6)}`);
        const r = await enrolAgent(channelDeps(adminId), {agentId, password: PASSWORD});
        if (!r.ok) throw new Error(`enrol: ${r.code}`);
        await t.db.update(forkAgentEnrollment).set({capabilities: o.caps ?? RUNNER_CAPS}).where(eq(forkAgentEnrollment.agentId, agentId));
        await q("insert into fork_runner (agent_id, designated_by, designated_at, updated_at) values ($1,$2,now(),now())", [agentId, adminId]);
        const name = (await q("select name from agents where id=$1", [agentId]))[0].name as string;
        const ru: Runner = {agentId, credential: decodeBundle(r.bundle).credential, name};
        if (o.targets !== false) {
            const rs = await setRunnerTargets({...channelDeps(adminId), mirrorsEnabled: () => true, resolve}, {agentId, targets: [{kind: "tcp", host: "10.20.30.25", port: 25, class: "smtp", label: "Prod SMTP"}]});
            if (!rs.ok) throw new Error(`targets: ${rs.code}`);
        }
        if (o.isolated !== false && o.targets !== false) await probeNow(ru);
        return ru;
    };

    const taskKey = async (agentId: string) => loadTaskKey({kekDir: kek}, (await t.db.select().from(forkAgentEnrollment).where(eq(forkAgentEnrollment.agentId, agentId)))[0]!);
    /** admin-style probe through the real service, answered by the fake runner */
    const probeNow = async (ru: Runner, outcome: "blocked" | "reachable" = "blocked") => {
        const {requestRunnerProbe} = await import("@/fork/runner/service");
        const p = await requestRunnerProbe({...channelDeps(adminId), mirrorsEnabled: () => true, resolve}, {agentId: ru.agentId});
        if (!p.ok) throw new Error(`probe: ${p.code}`);
        await step(ru, {runner_probe: {probeOutcome: outcome}});
    };

    const deps = (p: ForkPrincipal | null, w: W17, over: Partial<MirrorDeps> = {}): MirrorDeps => {
        const {principal: _p, ...ch} = chDeps(t, kek, key, p?.userId ?? null, {now});
        return {...ch, principal: p, now, artifactUrl: async (id) => `https://lab.invalid/${id}`, manifest: async () => ({json: w.manifestJson, sigB64: w.manifestSig}), resolve, mirrorsEnabled: () => flag.on,
            principalOf: async (id) => { const x = principals.get(id); return x ? {kind: "ok", principal: x} : {kind: "missing"}; }, ...over};
    };

    const POLICY = {v: 1, access: {service: "web", target: 8080}, http_path: "/", env: {}} as const;
    const createReq = (w: W17, ru: Runner, over: Record<string, unknown> = {}) => ({stackId: w.stack, rpId: w.rp, runnerAgentId: ru.agentId, name: `m${randomUUID().slice(0, 6)}`, policy: POLICY, keepConfirmations: {}, acknowledgePrivacy: false, ...over});

    /** The fake runner: leases the next task of `ru` and answers it from its decrypted payload. */
    const rawStep = async (ru: Runner, script: Script = {}, o: {lapse?: boolean; caps?: string[]} = {}): Promise<{type: string; taskId: string; payload: Doc} | null> => {
        const auth = await authenticateAgent(t.db, {agentId: ru.agentId, authorization: `Bearer ${ru.credential}`, source: "1.2.3.4", now: now()});
        if (!auth.ok) throw new Error(`auth: ${auth.code}`);
        const l = await leaseTask(t.db, auth.enrollment, {capabilities: o.caps ?? RUNNER_CAPS, leaseSeconds: 60, now: now()});
        if (!l) return null;
        const type = JSON.parse(l.envelope).type as string;
        const [row] = await q("select payload_enc from fork_agent_task where id=$1", [l.task_id]);
        const payload = JSON.parse(decryptPayload(await taskKey(ru.agentId), {taskId: l.task_id, agentId: ru.agentId, type}, row.payload_enc).toString("utf8")) as Doc;
        if (o.lapse) return {type, taskId: l.task_id, payload};
        const s = script[type];
        const reply: Reply = {...defaults(type, payload, ru), ...(typeof s === "function" ? s(payload) : s ?? {})};
        const restoreId = (payload.restore_id as string | undefined) ?? "";
        if (type === "mirror_render" && (reply.status ?? "succeeded") === "succeeded") {
            const ws = payload.workspace as string;
            const doc = reply.sourceDoc ?? (JSON.parse(JSON.stringify(labFull()).split(LAB_WS).join(ws)) as Doc);
            await upload(auth.enrollment, l.task_id, l.lease_id, restoreId, Buffer.from(JSON.stringify(blankPolicyView(doc))));
        }
        if (type === "mirror_finalize" && (reply.status ?? "succeeded") === "succeeded") {
            const view = Buffer.from(JSON.stringify(finalViewOf(payload.spec, restoreId, reply.finalMutate)));
            await upload(auth.enrollment, l.task_id, l.lease_id, restoreId, view);
            reply.result = {v: 1, view_sha256: sha(view), services: Object.keys(payload.spec.view.services).length, ...(reply.result ?? {})};
        }
        const r = await submitResult(t.db, auth.enrollment, {taskId: l.task_id, organizationId: org, now: now(), body: {lease_id: l.lease_id, status: reply.status ?? "succeeded", ...(reply.reason ? {reason: reply.reason} : {}), ...(reply.result ? {result: reply.result} : {})}});
        if (!r.ok) throw new Error(`submitResult(${type}): ${r.code}`);
        return {type, taskId: l.task_id, payload};
    };
    const upload = async (enrollment: Parameters<typeof submitRender>[1], taskId: string, leaseId: string, restoreId: string, view: Buffer) => {
        const r = await submitRender(t.db, enrollment, {taskId, organizationId: org, now: now(), body: {lease_id: leaseId, restore_id: restoreId, view_b64: view.toString("base64"), view_sha256: sha(view),
            raw: {refused: false, violations: [], reason: null}, roots: ["/srv/portabase-mirrors"], files: ["compose.yml"], compose_version: "5.4.0", rules_sha256: RULES_SHA256}});
        if (!r.ok) throw new Error(`submitRender: ${r.code}`);
    };

    const defaults = (type: string, p: Doc, ru: Runner): Reply => {
        switch (type) {
            case "mirror_probe": return {result: {roots: [{path: "/srv/portabase-mirrors", shared: true, free_bytes: 1e12}], workspace_state: "absent", arch: "x86_64", compose_version: "5.4.0", rules_sha256: RULES_SHA256, mem_available_bytes: 64 * 1024 ** 3}};
            case "mirror_stage": return {result: {staged: [], extracted: [], manifest_sequence: seqOf(p), kid: key.kid}};
            case "mirror_apply": return {result: {volumes: []}};
            case "mirror_db": return {result: {v: 1, dbs: (p.dbs as {index: number; service: string}[]).map((d) => ({...d, status: "restored"})), resets: (p.resets as {service: string}[]).map((r) => ({service: r.service, status: "done"}))}};
            case "mirror_up": return {result: {v: 1, services: [{service: "db", state: "running"}, {service: "web", state: "running"}]}};
            case "mirror_check": return {result: {v: 1, services: [{service: "db", state: "running", health: "healthy"}, {service: "web", state: "running", health: "none"}], smoke: {status: "ok", http_status: 200}}};
            case "mirror_wipe": return {result: {v: 1, containers: 2, networks: 2, volumes: 2, workspace_removed: true, remaining: 0}};
            case "mirror_stop": return {result: {v: 1, stopped: 2, services: [{service: "db", state: "exited"}, {service: "web", state: "exited"}], remaining: 0}};
            case "mirror_route": return {result: p.action === "remove" ? {v: 1, removed: {container: 1, dir: true}, remaining: 0} : {v: 1, route_port: p.route_port, switched: true, smoke: {status: "ok", http_status: 200}}};
            case "runner_probe": return {result: {}}; // filled by probeResult below
            default: return {};
        }
    };
    const seqOf = (_p: Doc) => stackSeq.current;
    const stackSeq = {current: 0};

    // the runner_probe reply is built from the probe payload (probe id, target ids, targets sha): wrap the raw step for that type
    const withProbe = (script: Script): Script => ({
        ...script,
        runner_probe: ((payload: Doc) => {
            const given = script.runner_probe;
            const g = (typeof given === "function" ? given(payload) : given) ?? {};
            const outcome = g.probeOutcome ?? "blocked";
            return {...g, result: g.result ?? {v: 1, probe_id: payload.probe_id, targets_sha256: payload.targets_sha256, self_dns: "ok", results: (payload.targets as {id: string}[]).map((x, i) => ({id: x.id, outcome: i === 0 ? outcome : "blocked"})), wiped: {containers: 0, networks: 0}}};
        }) as (p: Doc) => Reply,
    });
    const step = (ru: Runner, script: Script = {}, o: {lapse?: boolean; caps?: string[]} = {}) => rawStep(ru, withProbe(script), o);

    const rev = async (id: string) => (await q("select * from fork_mirror_revision where id=$1", [id]))[0]!;
    const mirrorRow = async (id: string) => (await q("select * from fork_mirror where id=$1", [id]))[0]!;
    const events = (mirrorId: string) => q("select kind, from_state, to_state, code, details from fork_mirror_event where mirror_id=$1 order by at, id", [mirrorId]);
    const audits = (action: string) => q("select result, redacted_details d, resource_id from fork_audit_event where action=$1 order by seq", [action]);
    const journal = (revisionId: string) => q("select step, attempt, task_type from fork_mirror_task where revision_id=$1 order by created_at, attempt", [revisionId]);

    /** tick (orchestrator + wipe phase) → fake runner … until the revision is READY or terminal with a finished wipe (or `max` rounds). */
    const drive = async (d: MirrorDeps, ru: Runner, revisionId: string, script: Script = {}, o: {max?: number; stopAt?: (r: Record<string, any>) => boolean; stopWhenTerminal?: boolean} = {}) => {
        for (let i = 0; i < (o.max ?? 80); i++) {
            await tickAllMirrors(d);
            const r = await rev(revisionId);
            if (o.stopAt?.(r)) return r;
            const terminal = !["requested", "planning", "validating", "staging", "restoring_files", "transforming", "restoring_db", "starting", "healthchecking"].includes(r.state);
            if (terminal && (r.state === "ready" || o.stopWhenTerminal || ["verified", "not_needed", "failed"].includes(r.wipe_state))) return r;
            await step(ru, script);
        }
        return rev(revisionId);
    };

    const setSeq = async (w: W17) => { stackSeq.current = Number((await q("select sequence from fork_recovery_point where id=$1", [w.rp]))[0].sequence); };
    const dump = async (): Promise<string> => {
        const tables = (await q("select table_name from information_schema.tables where table_name like 'fork\\_%' and table_schema='public'")).map((r) => r.table_name as string);
        let all = "";
        for (const tn of tables) all += (await q(`select coalesce(string_agg(row_to_json(x)::text, E'\\n'), '') as s from "${tn}" x`))[0].s;
        return all;
    };
    return {t, pool, kek, key, org, otherOrg, adminId, q, now, advance, user, principals, world, runner, runnerStep: step, probeNow, deps, createReq, POLICY, rev, mirrorRow, events, audits, journal, drive, setSeq, dump, flag,
        reset: () => resetRateLimits(), close: async () => { await t.drop(); }, resolve, channelDeps};
}
export type MirrorWorld = Awaited<ReturnType<typeof mirrorWorld>>;
export type {compileMirror};
