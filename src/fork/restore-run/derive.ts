import {z} from "zod";
import type {RestorePlanV1} from "@/fork/restore/schema";
import {engineCheckCount} from "@/fork/restore-tasks/build";
import type {RestoreStep} from "./vocab";

/**
 * Pure derivation + per-step result checks of the W18a orchestrator (no Date / env / DB / crypto). The agent is authoritative for every check
 * here; the dashboard repeats them as defence in depth and to give the operator an exact reason.
 */
export type Check = {ok: true} | {ok: false; code: string};
const OK: Check = {ok: true};
const bad = (code: string): Check => ({ok: false, code});

const live = (plan: RestorePlanV1) => plan.actions.filter((a) => a.op !== "skip");
export const needsCompose = (plan: RestorePlanV1): boolean => live(plan).some((a) => a.kind === "compose_up");
export const needsDb = (plan: RestorePlanV1): boolean => live(plan).some((a) => a.kind === "restore_db_dump" && a.destination.kind === "db_service" && a.source.dbms === "postgresql");

/**
 * verify_manifest → probe → stage → apply → [render → (restore_db) → compose_up → check_services].
 * D29 / W17b (quiesce / guard) add their steps HERE with their own handlers. W-TR appends `integrity` for test restores; its verified wipe is a separate post-terminal phase.
 */
export function deriveSteps(plan: RestorePlanV1): RestoreStep[] {
    const steps: RestoreStep[] = ["verify_manifest", "probe", "stage", "apply"];
    if (needsCompose(plan)) {
        steps.push("render");
        if (needsDb(plan)) steps.push("restore_db");
        steps.push("compose_up", "check_services");
    }
    // W-TR: a data-only test restore ends with the engine integrity check (only when at least one artifact has a checker)
    if (plan.purpose === "test_restore" && engineCheckCount(plan).checkable > 0) steps.push("integrity");
    return steps;
}

const Verify = z.object({checks: z.array(z.object({index: z.number(), engine: z.enum(["sqlite", "postgresql"]), status: z.literal("ok")})).max(100)});
/** W-TR: the `restore_verify` result must report exactly `expected` checks, all `ok`. Anything else is `integrity_failed`. */
export function checkVerify(result: unknown, expected: number): Check {
    const r = Verify.safeParse(result);
    return r.success && r.data.checks.length === expected ? OK : bad("integrity_failed");
}

/** Σ distinct-artifact `expect.plaintext_size` (nulls ignored). */
export function neededBytes(plan: RestorePlanV1): number {
    const seen = new Set<string>();
    let total = 0;
    for (const a of live(plan)) {
        const id = a.artifact_ids[0];
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        total += a.expect.plaintext_size ?? 0;
    }
    return total;
}

const Probe = z.object({
    roots: z.array(z.object({path: z.string(), shared: z.boolean(), free_bytes: z.number().nullable()})).max(64),
    workspace_state: z.enum(["absent", "owned", "foreign"]).nullable(),
    compose_version: z.string().nullable(),
    rules_sha256: z.string().nullable(),
});

export function checkProbe(result: unknown, plan: RestorePlanV1, rulesSha256: string): Check {
    const p = Probe.safeParse(result);
    if (!p.success) return bad("probe_invalid");
    const root = plan.target.restore_root;
    if (!root) return bad("root_missing");
    const r = p.data.roots.find((x) => root === x.path || root.startsWith(`${x.path.replace(/\/+$/, "")}/`));
    if (!r) return bad("root_missing");
    if (!r.shared) return bad("root_not_shared");
    if (r.free_bytes !== null && r.free_bytes < neededBytes(plan)) return bad("insufficient_disk");
    if (p.data.workspace_state === "foreign") return bad("workspace_not_owned");
    if (needsCompose(plan)) {
        if (p.data.compose_version === null) return bad("compose_unavailable");
        if (p.data.rules_sha256 !== rulesSha256) return bad("rules_mismatch");
    }
    return OK;
}

export function checkStage(result: unknown, plan: RestorePlanV1): Check {
    const r = result as {manifest_sequence?: unknown} | null;
    return r && typeof r === "object" && r.manifest_sequence === plan.rp.sequence ? OK : bad("stage_mismatch");
}

const Db = z.object({dbs: z.array(z.object({status: z.string()})).max(500)});
export function checkDb(result: unknown): Check {
    const r = Db.safeParse(result);
    return r.success && r.data.dbs.every((d) => d.status === "restored" || d.status === "reused") ? OK : bad("db_restore_failed");
}

export const ServiceState = z.strictObject({service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/), state: z.enum(["running", "exited"])});
export type ServiceState = z.infer<typeof ServiceState>;
const Up = z.object({services: z.array(ServiceState).max(500)});
/** `compose_up` result → validated service list (names + running/exited only), or `null` when malformed. */
export function parseServices(result: unknown): ServiceState[] | null {
    const r = Up.safeParse(result);
    return r.success ? r.data.services : null;
}

/** Service names of the render's policy view (`services` map keys). Anything unparsable yields `null`. */
export function expectedServices(policyViewText: string): string[] | null {
    try {
        const doc = JSON.parse(policyViewText) as {services?: unknown};
        if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object" || Array.isArray(doc.services)) return null;
        return Object.keys(doc.services);
    } catch { return null; }
}

/** Every service of the render must be reported `running`; one exited or missing service ⇒ `service_not_running` (terminal `incomplete`, never success). */
export function checkServices(policyViewText: string, services: readonly ServiceState[]): Check {
    const want = expectedServices(policyViewText);
    if (!want || want.length === 0) return bad("service_not_running");
    const got = new Map(services.map((s) => [s.service, s.state]));
    return want.every((s) => got.get(s) === "running") ? OK : bad("service_not_running");
}
