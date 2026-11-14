import {z} from "zod";
import {PLAIN, type RefusalCode} from "@/fork/compose-compiler/ir";
import type {RevRow, MirrorRow} from "./steps";
import {GATES, type Gate} from "./vocab";

/**
 * Read model of a mirror (W22a → W22b / W23). A strict allowlist: ids, names, states, codes, booleans, counts, timestamps. NO workspace path, spec, env key or action, URL, task result,
 * seed or rotated value (the W20 spec is value-free but the browser never needs it). Refusal sentences are the fixed plain-language texts of the compiler.
 */
const iso = z.string();
export const MirrorView = z.strictObject({
    mirror: z.strictObject({id: z.string(), name: z.string(), status: z.string(), runnerName: z.string(), stackId: z.string(), activeRevisionId: z.string().nullable(), createdAt: iso}),
    revisions: z.array(z.strictObject({
        id: z.string(), seq: z.number(), state: z.string(), reason: z.string().nullable(), failedStep: z.string().nullable(),
        steps: z.array(z.strictObject({name: z.string(), status: z.string()})),
        gates: z.strictObject({expected_data: z.strictObject({ok: z.boolean(), code: z.string().nullable()}).nullable(), db_health: z.strictObject({ok: z.boolean(), code: z.string().nullable()}).nullable(),
            app_smoke: z.strictObject({ok: z.boolean(), code: z.string().nullable()}).nullable(), isolation: z.strictObject({ok: z.boolean(), code: z.string().nullable()}).nullable(),
            side_effects: z.strictObject({ok: z.boolean(), code: z.string().nullable()}).nullable()}),
        refusals: z.array(z.strictObject({code: z.string(), service: z.string().nullable(), text: z.string()})),
        services: z.array(z.strictObject({service: z.string(), state: z.string(), health: z.string().nullable()})),
        hostPort: z.number(), rpSequence: z.number(), readiedAt: iso.nullable(), wipeState: z.string().nullable(), deadlineAt: iso, createdAt: iso,
    })),
    privacy: z.strictObject({containsPersonalData: z.boolean().nullable(), optIn: z.boolean()}),
});
export type MirrorView = z.infer<typeof MirrorView>;

const KEPT = "A production secret was kept as it is, but was not confirmed by typing its phrase.";
const refusalText = (code: string, service: string | null): string =>
    code === "kept_secret_unconfirmed" ? KEPT : code in PLAIN ? `${service === null ? "The Compose file" : `Service "${service}"`} ${PLAIN[code as RefusalCode]}.` : "The app cannot be mirrored safely.";

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function toMirrorView(m: MirrorRow, revs: RevRow[], p: {containsPersonalData: boolean | null; optIn: boolean}): MirrorView {
    return MirrorView.parse({
        mirror: {id: m.id, name: m.name, status: m.status, runnerName: m.runnerAgentName, stackId: m.stackId, activeRevisionId: m.activeRevisionId, createdAt: m.createdAt.toISOString()},
        revisions: [...revs].sort((a, b) => b.seq - a.seq).map((r) => {
            const g = (r.gates && typeof r.gates === "object" ? r.gates : {}) as Partial<Record<Gate, {ok?: unknown; code?: unknown}>>;
            const gate = (k: Gate) => (g[k] ? {ok: g[k]?.ok === true, code: str(g[k]?.code)} : null);
            return {
                id: r.id, seq: r.seq, state: r.state, reason: r.reason, failedStep: r.failedStep,
                steps: asArray(r.steps).map((s) => ({name: String((s as {name?: unknown}).name ?? ""), status: String((s as {status?: unknown}).status ?? "")})),
                gates: Object.fromEntries(GATES.map((k) => [k, gate(k)])),
                refusals: asArray(r.refusals).map((x) => ({code: String((x as {code?: unknown}).code ?? ""), service: str((x as {service?: unknown}).service), text: refusalText(String((x as {code?: unknown}).code ?? ""), str((x as {service?: unknown}).service))})),
                services: asArray(r.services).map((s) => ({service: String((s as {service?: unknown}).service ?? ""), state: String((s as {state?: unknown}).state ?? ""), health: str((s as {health?: unknown}).health)})),
                hostPort: r.hostPort, rpSequence: r.rpSequence, readiedAt: r.readiedAt ? r.readiedAt.toISOString() : null, wipeState: r.wipeState, deadlineAt: r.deadlineAt.toISOString(), createdAt: r.createdAt.toISOString(),
            };
        }),
        privacy: p,
    });
}
