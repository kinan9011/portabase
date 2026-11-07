import {z} from "zod";
import {validateCompleteness} from "@/fork/completeness";
import type {CompletenessContext, ProbeResult} from "@/fork/completeness/types";
import {toItemView, ItemViewSchema} from "@/fork/completeness/view";
import type {StackInventoryV1} from "@/fork/inventory/schema";
import {planStack} from "@/fork/materialize/plan";
import {DUMP_ENGINES, type Selection} from "@/fork/materialize/types";
import {estimateSize} from "./size-estimate";
import {SELECTION_ISSUE_CODES, validateSelection} from "./validate-selection";

/**
 * Read-only "what would be protected" view of a PENDING selection (W11 Review section). Pure: the stored inventory never leaves the
 * server (W08 wall), so the browser asks for this preview instead of recomputing it. Nothing is written.
 *
 * Honesty: the host-readability probe only exists after activation (the agent reports it). The preview therefore assumes "readable" for
 * the keys the plan covers and says so in the UI; the real status appears on the Configuration tab. What the preview CAN say for sure
 * is what the plan does not cover at all.
 */
export const PLAN_VERDICTS = ["backed_up", "not_backed_up", "external", "excluded", "accepted"] as const;

export const PreviewViewSchema = z.strictObject({
    items: z.array(ItemViewSchema.extend({plan: z.enum(PLAN_VERDICTS)})).max(5000),
    sources: z.array(z.strictObject({
        name: z.string().max(255), role: z.enum(["compose", "env", "bind", "volume", "db"]), dbms: z.string().max(32), origin: z.enum(["discovered", "manual"]),
        covers: z.number().int().min(0), needsSecret: z.boolean(), secretFor: z.string().max(128).nullable(), requiresDocker: z.boolean(),
    })).max(500),
    skipped: z.array(z.strictObject({key: z.string().max(1200), reason: z.string().max(64)})).max(1000),
    issues: z.array(z.strictObject({field: z.string().max(1300), key: z.string().max(1300), code: z.enum(SELECTION_ISSUE_CODES)})).max(200),
    needsSecrets: z.array(z.string().max(128)).max(100),
    dockerGate: z.boolean(),
    size: z.strictObject({bytes: z.number().int().min(0).nullable(), counted: z.number().int(), unknown: z.number().int()}),
    gaps: z.number().int().min(0),
    stopHints: z.array(z.string().max(128)).max(500),
});
export type PreviewView = z.infer<typeof PreviewViewSchema>;

export function computePreview(inv: StackInventoryV1, sel: Selection, accepted: readonly string[], allowedRoots: readonly string[]): PreviewView {
    const plan = planStack(inv, sel, allowedRoots);
    const probes: Record<string, ProbeResult> = {};
    for (const k of Object.keys(plan.coverage)) probes[k] = "readable";
    const ctx: CompletenessContext = {coverage: plan.coverage, probes, acceptedExclusions: accepted, allowedRoots, sourceIssues: []};
    const report = validateCompleteness(inv, ctx);
    const verdict = (i: (typeof report.items)[number]): (typeof PLAN_VERDICTS)[number] =>
        i.status === "captured" ? "backed_up" : i.status === "accepted_exclusion" ? "accepted" : i.status === "excluded" ? "excluded" : i.status === "external" ? "external" : "not_backed_up";
    const dockerGate = plan.sources.some((s) => s.requiresDocker);
    return PreviewViewSchema.parse({
        items: report.items.map((i) => ({...toItemView(i), plan: verdict(i)})),
        sources: plan.sources.map((s) => ({name: s.memberName, role: s.role, dbms: s.dbms, origin: s.origin, covers: s.covers.length, needsSecret: s.needsSecret, secretFor: s.secretFor, requiresDocker: s.requiresDocker})),
        skipped: plan.skipped.map((s) => ({key: s.key, reason: s.reason})),
        issues: validateSelection(inv, sel, allowedRoots, plan),
        needsSecrets: [...new Set(plan.sources.filter((s) => s.needsSecret && s.secretFor).map((s) => s.secretFor as string))],
        dockerGate,
        size: estimateSize(inv, plan),
        gaps: report.items.filter((i) => i.gap).length,
        stopHints: inv.services.filter((s) => s.backup_hints?.stop === true).map((s) => s.name),
    });
}
export const SUPPORTED_DUMP_ENGINES: readonly string[] = DUMP_ENGINES;
