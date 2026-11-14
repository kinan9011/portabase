/**
 * Pure derivation + per-step result checks of the mirror orchestrator and its READY gates (W22a, plan-W22a §3.5 / A6). No Date / env / DB / crypto. The runner is
 * authoritative for every check here; the dashboard repeats them as defence in depth and to give the operator an exact reason. A forged result or final view that
 * fails any check here can never reach `ready`.
 */
import {checkMirrorView, type MirrorAccess, type MirrorSpecV1} from "@/fork/compose-compiler/compile";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {isPolicyView} from "@/fork/restore-tasks/view";
import {MirrorCheckResult, MirrorDbResult} from "./payload-schema";
import {neededBytes} from "@/fork/restore-run/derive";
import {CAPACITY_DISK_FACTOR, MIRROR_STEPS, type MirrorStep, PORT_RANGE} from "./vocab";

export type Check = {ok: true} | {ok: false; code: string};
const OK: Check = {ok: true};
const bad = (code: string): Check => ({ok: false, code});

/** Every mirror runs the full ladder; `restore_db` / `finalize` outcomes decide at run time whether a task is needed (empty DB work ⇒ the step is a no-op). */
export const deriveMirrorSteps = (_plan: RestorePlanV1): MirrorStep[] => [...MIRROR_STEPS];

export type FinalLimits = {mem_bytes: number; pids: number; nano_cpus: number};
export type FinalViewCtx = {project: string; workspace: string; access: NonNullable<MirrorAccess>; sourceViewText: string; limits: FinalLimits};
export type FinalViewCheck = {ok: true} | {ok: false; code: "final_view_invalid" | "limits_invalid"; violations: string[]};

const num = (v: unknown): number | null => {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && /^[0-9]+(\.[0-9]+)?$/.test(v)) return Number(v);
    return null;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The FINAL policy view (what `mirror_finalize` produced on the runner) judged by the dashboard: policy-view shape (no value in a blanked field), the W20 mirror
 * invariants with owner labels required (no published port except 127.0.0.1:host_port, internal networks only, no host path outside the workspace, images
 * unchanged), and per-service resource limits present, numeric, positive and not above the policy.
 */
export function checkFinalView(viewText: string, ctx: FinalViewCtx): FinalViewCheck {
    let view: unknown;
    let source: unknown;
    try { view = JSON.parse(viewText); source = JSON.parse(ctx.sourceViewText); } catch { return {ok: false, code: "final_view_invalid", violations: ["json"]}; }
    if (!isObj(view) || !isObj(source) || !isPolicyView(view)) return {ok: false, code: "final_view_invalid", violations: ["shape"]};
    const chk = checkMirrorView(view, {project: ctx.project, workspace: ctx.workspace, access: ctx.access, source, requireOwnerLabels: true});
    if (!chk.ok) return {ok: false, code: "final_view_invalid", violations: chk.violations.map((x) => `${x.code}:${x.service ?? "-"}`)};
    const out: string[] = [];
    const services = isObj(view.services) ? view.services : {};
    if (Object.keys(services).length === 0) out.push("no_services");
    for (const [name, raw] of Object.entries(services)) {
        const s = isObj(raw) ? raw : {};
        const mem = num(s.mem_limit), pids = num(s.pids_limit), cpus = num(s.cpus);
        if (mem === null || mem <= 0 || mem > ctx.limits.mem_bytes) out.push(`mem_limit:${name}`);
        if (pids === null || pids <= 0 || pids > ctx.limits.pids) out.push(`pids_limit:${name}`);
        if (cpus === null || cpus <= 0 || cpus > ctx.limits.nano_cpus / 1e9 + 1e-9) out.push(`cpus:${name}`);
    }
    return out.length === 0 ? {ok: true} : {ok: false, code: "limits_invalid", violations: out};
}

/** Every production secret the compiled spec keeps (`keep_exact` on a rotate-classified key) must have been confirmed by the operator. */
export const checkKept = (spec: Pick<MirrorSpecV1, "kept_production_secrets">, confirmed: readonly string[]): boolean => {
    const ok = new Set(confirmed);
    return spec.kept_production_secrets.every((k) => ok.has(k));
};

/** `mirror_check` services: all expected ones reported, all `running`, none `unhealthy` / still `starting`. A service without a healthcheck reports `none` (allowed). */
export function checkHealth(result: unknown, expected: readonly string[] = []): Check {
    const r = MirrorCheckResult.safeParse(result);
    if (!r.success || r.data.services.length === 0) return bad("execution_error");
    const got = new Map(r.data.services.map((s) => [s.service, s]));
    for (const e of expected) if (!got.has(e)) return bad("service_not_running");
    for (const s of r.data.services) if (s.state !== "running") return bad("service_not_running");
    for (const s of r.data.services) if (s.health === "unhealthy" || s.health === "starting") return bad("service_unhealthy");
    return OK;
}

/** App smoke: TCP connect ok; with an http path the status must be 100–499 (a 5xx is a failed smoke). */
export function checkSmoke(result: unknown, policy: {http_path: string | null}): Check {
    const r = MirrorCheckResult.safeParse(result);
    if (!r.success || r.data.smoke.status !== "ok") return bad("smoke_failed");
    if (policy.http_path !== null) {
        const s = r.data.smoke.http_status;
        if (s === null || s < 100 || s > 499) return bad("smoke_failed");
    }
    return OK;
}

/** `mirror_db` result: exactly the dumps and resets that were asked for, all done. */
export function checkDbStep(result: unknown, expectDbs: number, expectResets: number): Check {
    const r = MirrorDbResult.safeParse(result);
    return r.success && r.data.dbs.length === expectDbs && r.data.resets.length === expectResets ? OK : bad("db_restore_failed");
}

/** Lowest free loopback port of the runner's range, or `null`. */
export function allocatePort(used: readonly number[], range: {min: number; max: number} = PORT_RANGE): number | null {
    const taken = new Set(used);
    for (let p = range.min; p <= range.max; p++) if (!taken.has(p)) return p;
    return null;
}

/**
 * W24 capacity preflight (ADR-017 §capacity), run on the `mirror_probe` result AFTER the shared `checkProbe` (restore semantics untouched): the free disk of the plan's root must cover the plan's plaintext
 * need with 10 % headroom; a REFRESH (a second revision beside a running one) additionally needs `mem_available_bytes >= memNeed` and fails CLOSED when the runner did not report a fact
 * (`capacity_unknown`). A first creation keeps the old behaviour (an unreported free disk passes) except for the headroom.
 */
export function checkMirrorCapacity(result: unknown, plan: RestorePlanV1, o: {refresh: boolean; memNeed: number}): Check {
    const r = (result && typeof result === "object" ? result : {}) as {roots?: unknown; mem_available_bytes?: unknown};
    const root = plan.target.restore_root;
    let free: number | null = null;
    if (root && Array.isArray(r.roots)) {
        for (const x of r.roots as {path?: unknown; free_bytes?: unknown}[]) {
            if (typeof x?.path !== "string") continue;
            if (root === x.path || root.startsWith(`${x.path.replace(/\/+$/, "")}/`)) { free = typeof x.free_bytes === "number" && Number.isFinite(x.free_bytes) ? x.free_bytes : null; break; }
        }
    }
    const mem = typeof r.mem_available_bytes === "number" && Number.isFinite(r.mem_available_bytes) && r.mem_available_bytes >= 0 ? r.mem_available_bytes : null;
    if (o.refresh && (free === null || mem === null)) return bad("capacity_unknown");
    if (free !== null && free < Math.ceil(neededBytes(plan) * CAPACITY_DISK_FACTOR)) return bad("insufficient_disk");
    if (o.refresh && mem !== null && mem < o.memNeed) return bad("insufficient_memory");
    return OK;
}
