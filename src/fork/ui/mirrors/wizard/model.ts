import type {MirrorView} from "@/fork/mirror/view";
import {keepConfirmPhrase, TERMINAL_REVISION_STATES} from "@/fork/mirror/vocab";
import type {EnvActionKey, RunnerReasonKey} from "@/fork/ui/mirrors/labels";
import {MIRRORS} from "@/fork/ui/mirrors/labels";

/**
 * Pure model of the "Create test mirror" wizard (plan-W22b §4 Step 1). No React, no server import (values only from `@/fork/mirror/vocab`): client components and tests share it.
 * Env KEY NAMES appear here; env VALUES never exist on the dashboard.
 */
export type EnvClass = "rotate" | "disable" | "keep";
export type ServiceFacts = {name: string; ports: {target: number; protocol: "tcp" | "udp"; published: boolean}[]; database: string | null; env: {key: string; recommended: EnvClass}[]};
export type Access = {service: string; target: number};
export type Actions = Record<string, Record<string, EnvActionKey>>;
export type PreviewUi = {outcome: string; blockers: string[]; actions: number; containsPersonalData: boolean | null; optIn: boolean; runnerIsolation: string};

/** Local copy of `HTTP_PATH_RE` of `mirror/payload-schema.ts` (that module pulls zod server code into the bundle); a unit test pins them equal. */
export const HTTP_PATH_RE_LOCAL = /^\/[A-Za-z0-9._~/-]{0,127}$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const tcp = (s: ServiceFacts) => s.ports.filter((p) => p.protocol === "tcp");

/** First non-database service with a published TCP port, else first non-database TCP, else first TCP of any service, else null. */
export function defaultAccess(services: readonly ServiceFacts[]): Access | null {
    const web = services.filter((s) => s.database === null);
    const pub = web.find((s) => tcp(s).some((p) => p.published));
    if (pub) return {service: pub.name, target: tcp(pub).find((p) => p.published)!.target};
    const first = web.find((s) => tcp(s).length > 0) ?? services.find((s) => tcp(s).length > 0);
    return first ? {service: first.name, target: tcp(first)[0]!.target} : null;
}

/** `<stack-slug>-<seq>`: lowercase ASCII, `[^a-z0-9]+` → `-`, trimmed, base cut to 33 so the result is ≤ 40 characters and matches `NAME_RE`. */
export function defaultMirrorName(stackName: string, seq: number): string {
    const base = stackName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 33).replace(/-+$/g, "");
    return base === "" ? `mirror-${seq}` : `${base}-${seq}`;
}

/** The key's current action: the user's choice, else the recommended one. */
export const actionOf = (actions: Actions, svc: string, key: string, recommended: EnvClass): EnvActionKey => actions[svc]?.[key] ?? recommended;

export type CreateChoices = {
    stackId: string; rpId: string; runnerAgentId: string; name: string; access: Access; httpPath: string | null;
    actions: Actions; typed: Record<string, string>; ack: boolean;
};

/** Exactly the `CreateMirrorRequest` shape (DD-5): env holds only OVERRIDES of the compiler default (`keep_exact` always), confirmations only for kept keys, limits omitted (server defaults). */
export function buildCreateInput(c: CreateChoices, services: readonly ServiceFacts[]) {
    const env: Record<string, Record<string, EnvActionKey>> = {};
    const keepConfirmations: Record<string, string> = {};
    for (const s of services) {
        for (const e of s.env) {
            const a = actionOf(c.actions, s.name, e.key, e.recommended);
            if (a === "keep_exact" || a !== e.recommended) { env[s.name] = {...env[s.name], [e.key]: a}; }
            if (a === "keep_exact") keepConfirmations[`${s.name}.${e.key}`] = c.typed[`${s.name}.${e.key}`] ?? "";
        }
    }
    return {
        stackId: c.stackId, rpId: c.rpId, runnerAgentId: c.runnerAgentId, name: c.name,
        policy: {v: 1 as const, access: c.access, http_path: c.httpPath, env},
        keepConfirmations, acknowledgePrivacy: c.ack,
    };
}

/** Kept production values (`keep_exact`) whose typed phrase is not exactly `KEEP svc.KEY`, as `svc.KEY`. */
export function keptKeys(actions: Actions, services: readonly ServiceFacts[]): {svc: string; key: string}[] {
    const out: {svc: string; key: string}[] = [];
    for (const s of services) for (const e of s.env) if (actionOf(actions, s.name, e.key, e.recommended) === "keep_exact") out.push({svc: s.name, key: e.key});
    return out;
}
export function keepPending(actions: Actions, typed: Record<string, string>, services: readonly ServiceFacts[]): string[] {
    return keptKeys(actions, services).filter((k) => typed[`${k.svc}.${k.key}`] !== keepConfirmPhrase(k.svc, k.key)).map((k) => `${k.svc}.${k.key}`);
}

/** Number of settings whose action differs from the recommended one. */
export function changedCount(actions: Actions, services: readonly ServiceFacts[]): number {
    let n = 0;
    for (const s of services) for (const e of s.env) if (actionOf(actions, s.name, e.key, e.recommended) !== e.recommended) n++;
    return n;
}

/** First failing reason of the Create button (null = enabled). */
export function createBlockReason(s: {preview: PreviewUi | null; ack: boolean; needsAck: boolean; name: string; locked: boolean; keepPending: number; busy?: boolean}): string | null {
    const R = MIRRORS.review.reasons;
    if (s.busy) return MIRRORS.review.creating;
    if (s.locked) return R.locked;
    if (!s.preview) return R.preview;
    if (s.preview.outcome !== "ready") return R.blocked;
    if (s.preview.runnerIsolation !== "isolated") return R.isolation;
    if (!NAME_RE.test(s.name)) return R.name;
    if (s.keepPending > 0) return R.keep;
    if (s.needsAck && !s.ack) return R.ack;
    return null;
}

/** The progress poll stops: the latest revision is `ready`, or terminal with its wipe over (`verified`, `not_needed` or `failed` = needs a human). */
export function settled(view: MirrorView): boolean {
    if (["deleting", "stopping", "starting"].includes(view.mirror.status)) return false; // W23: a lifecycle action is in flight
    const r = view.revisions[0];
    if (!r) return true;
    if (r.state === "ready") return true;
    if (!(TERMINAL_REVISION_STATES as readonly string[]).includes(r.state)) return false;
    return r.wipeState === "verified" || r.wipeState === "not_needed" || r.wipeState === "failed";
}

export type RunnerUi = {id: string; name: string; status: "online" | "degraded" | "offline"; eligible: boolean; ineligible: string | null; isolation: "isolated" | "not_isolated" | "unknown"; isolationUnknown: string | null;
    probedAt: string | null; reachableCount: number; targetCount: number; probePending: boolean; busy: boolean; mirrorsHeld: number; freePorts: number};

/** Why a runner cannot be chosen now (first failing reason), or null when it is selectable: eligible, online, isolated, ≥ 1 probe target, not busy, a free port. */
export function runnerBlock(r: RunnerUi): RunnerReasonKey | null {
    if (!r.eligible) return (r.ineligible as RunnerReasonKey | null) ?? "not_a_runner";
    if (r.status === "offline") return "offline";
    if (r.isolation === "not_isolated") return "not_isolated";
    if (r.isolation === "unknown") return "isolation_unknown";
    if (r.targetCount === 0) return "no_targets";
    if (r.busy) return "busy";
    if (r.freePorts <= 0) return "no_ports";
    return null;
}
