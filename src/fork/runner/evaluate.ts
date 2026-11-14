import {z} from "zod";
import {targetsSha, type ProbeTarget} from "./targets";
import type {TargetClass} from "./vocab";

/**
 * The isolation verdict (W21 DD-7): a PURE function, fail closed. The agent only measures; this decides. There is NO input that is a network flag: `internal: true` on a network
 * is not evidence of anything (ADR-008), only the probe outcomes are.
 */
export const ProbeResult = z.strictObject({
    v: z.literal(1),
    probe_id: z.uuid(),
    targets_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    self_dns: z.enum(["ok", "fail"]),
    results: z.array(z.strictObject({id: z.string().regex(/^[a-z0-9]{1,8}$/), outcome: z.enum(["blocked", "reachable", "error"])})).min(1).max(32),
    wiped: z.strictObject({containers: z.number().int().min(0).max(1000), networks: z.number().int().min(0).max(1000)}),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export type UnknownReason = "never_probed" | "probe_pending" | "probe_failed" | "inconclusive" | "result_invalid" | "stale" | "targets_changed" | "not_a_runner" | "not_attested";
export type RunnerIsolation =
    | {state: "isolated"; probedAt: Date; targetCount: number}
    | {state: "not_isolated"; probedAt: Date | null; reachable: {id: string; class: TargetClass; label: string}[]}
    | {state: "unknown"; reason: UnknownReason};

export type EvalInput = {
    eligibility: {ok: true} | {ok: false; reason: "not_a_runner" | "not_attested"};
    /** `fork_runner` binding of the last probe (null ⇒ never probed). */
    last: {taskId: string | null; probeId: string | null; targets: ProbeTarget[] | null; configSha256: string | null} | null;
    /** The `fork_agent_task` row of `last.taskId`. */
    task: {id: string; status: string; result: unknown; finishedAt: Date | null} | null;
    expectedConfigSha: string;
    now: Date;
    maxAgeMs: number;
};

const PENDING = new Set(["queued", "leased", "running"]);

export function evaluateProbe(i: EvalInput): RunnerIsolation {
    const unknown = (reason: UnknownReason): RunnerIsolation => ({state: "unknown", reason});
    if (!i.eligibility.ok) return unknown(i.eligibility.reason);
    const {last, task} = i;
    if (!last || !last.taskId || !last.targets || !last.probeId || !last.configSha256 || !task || task.id !== last.taskId) return unknown("never_probed");
    if (PENDING.has(task.status)) return unknown("probe_pending");
    if (task.status !== "succeeded") return unknown("probe_failed");
    if (last.configSha256 !== i.expectedConfigSha) return unknown("targets_changed");
    const parsed = ProbeResult.safeParse(task.result);
    if (!parsed.success) return unknown("result_invalid");
    const r = parsed.data;
    if (r.probe_id !== last.probeId || r.targets_sha256 !== targetsSha(last.targets)) return unknown("result_invalid");
    const stored = new Map(last.targets.map((t) => [t.id, t]));
    const got = new Set(r.results.map((x) => x.id));
    if (got.size !== r.results.length || got.size !== stored.size || ![...stored.keys()].every((id) => got.has(id))) return unknown("result_invalid");
    const reachable = r.results.filter((x) => x.outcome === "reachable").map((x) => {
        const t = stored.get(x.id)!;
        return {id: x.id, class: t.class, label: t.label};
    });
    if (reachable.length > 0) return {state: "not_isolated", probedAt: task.finishedAt, reachable};
    if (r.self_dns !== "ok" || r.results.some((x) => x.outcome !== "blocked")) return unknown("inconclusive");
    if (!task.finishedAt || task.finishedAt.getTime() < i.now.getTime() - i.maxAgeMs) return unknown("stale");
    return {state: "isolated", probedAt: task.finishedAt, targetCount: r.results.length};
}

export class RunnerNotIsolatedError extends Error {
    constructor(readonly isolation: RunnerIsolation) {
        super(`runner is not isolated (${isolation.state}${isolation.state === "unknown" ? `: ${isolation.reason}` : ""})`);
        this.name = "RunnerNotIsolatedError";
    }
}
