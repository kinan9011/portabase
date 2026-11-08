/**
 * W17b payload + result schemas (pure zod). The agent re-validates the same grammar with `deny_unknown_fields`; the cross-language vectors
 * (`w17b-quiesce-vectors`) pin that. NO field is a command, image, path or container name: ids are 12..64 hex POINTERS that must resolve, on the agent, to
 * exactly one container of `project`.
 */
import {z} from "zod";
import {CONTAINER_OUTCOMES, MAX_TARGETS, RELEASED_BY} from "./vocab";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
export const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const service = z.string().regex(SERVICE_RE);
const containerId = z.string().regex(/^[0-9a-f]{12,64}$/);

export const TargetRefSchema = z.strictObject({service, container_id: containerId});

export const QuiescePayloadSchema = z.strictObject({
    v: z.literal(1),
    run_id: uuid,
    stack_id: uuid,
    project: z.string().regex(PROJECT_RE),
    targets: z.array(TargetRefSchema).min(1).max(MAX_TARGETS),
    max_stop_seconds: z.number().int().min(60).max(3600),
    stop_timeout_cap_seconds: z.number().int().min(10).max(300),
    start_timeout_seconds: z.number().int().min(30).max(600),
    dry_run: z.boolean(),
}).refine((p) => new Set(p.targets.map((t) => t.service)).size === p.targets.length && new Set(p.targets.map((t) => t.container_id)).size === p.targets.length, {message: "duplicate_target"});
export type QuiescePayload = z.infer<typeof QuiescePayloadSchema>;

export const QuiesceStartPayloadSchema = z.strictObject({v: z.literal(1), quiesce_task_id: uuid, project: z.string().regex(PROJECT_RE)});
export type QuiesceStartPayload = z.infer<typeof QuiesceStartPayloadSchema>;

export function buildQuiescePayload(i: {runId: string; stackId: string; project: string; targets: readonly {service: string; container_id: string}[]; maxStopSeconds: number; stopTimeoutCapSeconds: number; startTimeoutSeconds: number; dryRun: boolean}): QuiescePayload {
    return QuiescePayloadSchema.parse({
        v: 1, run_id: i.runId, stack_id: i.stackId, project: i.project, targets: i.targets.map((t) => ({service: t.service, container_id: t.container_id})),
        max_stop_seconds: i.maxStopSeconds, stop_timeout_cap_seconds: i.stopTimeoutCapSeconds, start_timeout_seconds: i.startTimeoutSeconds, dry_run: i.dryRun,
    });
}
export function buildQuiesceStartPayload(i: {quiesceTaskId: string; project: string}): QuiesceStartPayload {
    return QuiesceStartPayloadSchema.parse({v: 1, quiesce_task_id: i.quiesceTaskId, project: i.project});
}

/**
 * The agent's result object as stored by `submitResult` (flattened, plus an optional failure `reason`). Tolerant on purpose: `containers` may be trimmed
 * (`containers_truncated`) and the top-level summary fields are authoritative. `.strict()` keeps an unknown key from sneaking into our own state.
 */
export const QuiesceResultSchema = z.strictObject({
    project: z.string().max(128).optional(),
    released_by: z.enum(RELEASED_BY).optional(),
    window_intact: z.boolean().optional(),
    downtime_ms: z.number().int().min(0).max(7 * 24 * 3600 * 1000).optional(),
    all_verified: z.boolean().optional(),
    stopped_count: z.number().int().min(0).max(MAX_TARGETS).optional(),
    verified_count: z.number().int().min(0).max(MAX_TARGETS).optional(),
    containers_truncated: z.boolean().optional(),
    containers: z.array(z.strictObject({
        service: z.string().max(128), id12: z.string().max(12), was_running: z.boolean(), stopped: z.boolean(), started: z.boolean(), outcome: z.enum(CONTAINER_OUTCOMES),
    })).max(MAX_TARGETS).optional(),
    nothing_to_start: z.boolean().optional(),
    dry_run: z.boolean().optional(),
    targets: z.array(z.unknown()).max(MAX_TARGETS).optional(),
    reason: z.string().max(64).optional(),
    detail: z.string().max(64).optional(),
});
export type QuiesceResult = z.infer<typeof QuiesceResultSchema>;
