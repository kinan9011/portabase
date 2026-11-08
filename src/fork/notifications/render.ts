import {NOTIFY, QUIESCE} from "@/fork/ui/labels";
import {z} from "zod";
import {isDeliverableKind, type DeliverableKind, type NotifyEvent, type NotifyLevel} from "./vocab";

/**
 * Pure, total body renderer (§4.7, SEC-09): the notification is composed ONLY from fixed sentences (`ui/labels.ts NOTIFY`) selected by closed
 * codes, the SANITISED stack display name and a link built from a validated stack uuid + the operator's own `PROJECT_URL` origin. Nothing from a
 * run, an error, a path, a key name or an environment value can reach a body: payload values are looked up in closed tables, never interpolated.
 */
export type Rendered = {title: string; message: string; level: NotifyLevel; event: NotifyEvent};

const KIND_META: Record<DeliverableKind, {level: NotifyLevel; event: NotifyEvent; stackScoped: boolean}> = {
    "run.failed": {level: "critical", event: "error_backup", stackScoped: true},
    "run.blocked": {level: "warning", event: "error_backup", stackScoped: true},
    "run.incomplete": {level: "warning", event: "error_backup", stackScoped: true},
    "run.skipped": {level: "warning", event: "error_backup", stackScoped: true},
    "run.policy_paused": {level: "critical", event: "error_backup", stackScoped: true},
    "stack.partial": {level: "warning", event: "error_backup", stackScoped: true},
    "stack.no_good_backup": {level: "critical", event: "error_backup_missing", stackScoped: true},
    "kit.unverified": {level: "warning", event: "error_backup", stackScoped: true},
    "kit.key_rotated": {level: "warning", event: "error_backup", stackScoped: true},
    "fork.selfcheck.failed": {level: "warning", event: "error_backup", stackScoped: false},
    "fork.selfcheck.recovered": {level: "info", event: "success_backup_recovered", stackScoped: false},
    "restore.finished": {level: "info", event: "success_backup_recovered", stackScoped: true},
    "restore.failed": {level: "critical", event: "error_backup", stackScoped: true},
    "restore.needs_approval": {level: "warning", event: "error_backup", stackScoped: true},
    "test_restore.failed": {level: "critical", event: "error_backup", stackScoped: true},
    "test_restore.wipe_failed": {level: "critical", event: "error_backup", stackScoped: true},
    "test_restore.skipped": {level: "warning", event: "error_backup", stackScoped: true},
    "stack.test_restore_stale": {level: "warning", event: "error_backup", stackScoped: true},
    "quiesce.failed": {level: "critical", event: "error_backup", stackScoped: true},
    "stack.quiesce_stopped": {level: "critical", event: "error_backup", stackScoped: true},
};

const PayloadSchema = z.looseObject({stackId: z.uuid().optional(), reason: z.string().max(64).nullish(), hours: z.number().finite().optional(), state: z.string().max(32).optional(), since: z.iso.datetime().optional()});

/** Display name → a body-safe label: letters, digits, space, `_` and `-` only (a name that looks like a host or a URL would be auto-linked by chat channels), ≤ 60 chars. */
export function safeStackName(name: string | null | undefined): string {
    const cleaned = (name ?? "").normalize("NFKC").replace(/\./g, "_").replace(/[^\p{L}\p{N} _-]+/gu, "").replace(/\s+/g, " ").trim().slice(0, 60).trim();
    return cleaned === "" ? NOTIFY.stackFallback : cleaned;
}

/** `PROJECT_URL` → its origin (http/https only), else null (the link is then omitted, never guessed). */
export function baseOrigin(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
        const u = new URL(raw);
        return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
        return null;
    }
}

export function renderNotification(i: {kind: string; payload: unknown; stackName: string | null; baseUrl: string | null}): Rendered | null {
    if (!isDeliverableKind(i.kind)) return null;
    const meta = KIND_META[i.kind];
    const copy = NOTIFY.kinds[i.kind];
    const p = PayloadSchema.safeParse(i.payload ?? {});
    const payload = p.success ? p.data : {};
    const origin = baseOrigin(i.baseUrl);
    const path = meta.stackScoped && payload.stackId ? `/dashboard/stacks/${payload.stackId}` : "/dashboard/stacks";
    const reason = typeof payload.reason === "string" && Object.hasOwn(NOTIFY.reasons, payload.reason) ? NOTIFY.reasons[payload.reason] : null;
    const hours = i.kind === "stack.no_good_backup" && typeof payload.hours === "number" ? Math.max(0, Math.min(100_000, Math.floor(payload.hours))) : null;
    // W17b: state + closed reason sentences + (for the alert) the fixed-format UTC minute. Never a container name, id, path or raw error.
    const qState = typeof payload.state === "string" && Object.hasOwn(QUIESCE.states, payload.state) ? QUIESCE.states[payload.state as keyof typeof QUIESCE.states] : null;
    const qReasonKey = typeof payload.reason === "string" ? payload.reason : "";
    const qReason = Object.hasOwn(QUIESCE.skip, qReasonKey) ? QUIESCE.skip[qReasonKey as keyof typeof QUIESCE.skip] : Object.hasOwn(QUIESCE.agentCodes, qReasonKey) ? QUIESCE.agentCodes[qReasonKey] : null;
    const since = i.kind === "stack.quiesce_stopped" && payload.since ? QUIESCE.alert.line(payload.since.slice(0, 16).replace("T", " ")) : null;
    const quiesceLines = i.kind === "quiesce.failed" ? [...(qState ? [qState] : []), ...(qReason ? [qReason] : [])] : since ? [since] : [];
    const lines = [
        meta.stackScoped ? `${safeStackName(i.stackName)}: ${copy.sentence}` : copy.sentence,
        ...(hours !== null ? [NOTIFY.noGoodBackupHours(hours)] : []),
        ...(reason && !i.kind.startsWith("quiesce") ? [reason] : []),
        ...quiesceLines,
        origin ? `${origin}${path}` : NOTIFY.generic,
    ];
    return {title: `${NOTIFY.titlePrefix} · ${copy.title}`, message: lines.join("\n"), level: meta.level, event: meta.event};
}
