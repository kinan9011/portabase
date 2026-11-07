import {z} from "zod";
import {ForkForbiddenError, ForkNotFoundError} from "@/fork/acl";
import type {MaterializeDeps} from "@/fork/materialize/apply";
import {SelectionSchema} from "@/fork/materialize/types";
import {checkRate} from "@/fork/net/rate-limit";
import {assertForkResource} from "@/fork/resource-scope";
import {loadPreview} from "./configure-view";
import type {PreviewView} from "./preview";

/**
 * Read-only preview of a pending selection (W11 Review). Same authorisation as the mutation (system admin, resource-scoped, identical
 * `not_found`); no audit (a read, like the W08/W09 loaders), rate limited. It never carries a secret: the input has no password field.
 */
export const PreviewInputSchema = z.strictObject({
    stackId: z.uuid(),
    selection: SelectionSchema.default(SelectionSchema.parse({})),
    acceptedExclusions: z.array(z.string().min(3).max(1200)).max(500).default([]),
});
export type PreviewResult = {ok: true; preview: PreviewView} | {ok: false; code: "forbidden" | "not_found" | "rate_limited" | "invalid_input"; message: string};
export const PREVIEW_RATE = {limit: 120, windowMs: 60_000} as const;

export async function previewStackPolicy(d: MaterializeDeps, raw: unknown): Promise<PreviewResult> {
    const p = d.principal;
    if (!p) return {ok: false, code: "forbidden", message: "You must be signed in."};
    const parsed = PreviewInputSchema.safeParse(raw);
    if (!parsed.success) return {ok: false, code: "invalid_input", message: "Check the values you entered."};
    let organizationId: string;
    try {
        ({organizationId} = await assertForkResource(d.db, p, "stacks.backup.manage", {kind: "stack", id: parsed.data.stackId}));
    } catch (e) {
        if (e instanceof ForkNotFoundError) return {ok: false, code: "not_found", message: "Stack not found."};
        if (e instanceof ForkForbiddenError) return {ok: false, code: "forbidden", message: "Only a system administrator can configure backups."};
        throw e;
    }
    const rate = (d.rate ?? checkRate)(`${p.userId}:stack-policy-preview`, PREVIEW_RATE.limit, PREVIEW_RATE.windowMs, d.now?.().getTime());
    if (!rate.ok) return {ok: false, code: "rate_limited", message: `Too many requests. Try again in ${rate.retryAfterSeconds} s.`};
    const preview = await loadPreview(d.db, organizationId, parsed.data.stackId, parsed.data.selection, parsed.data.acceptedExclusions);
    return preview ? {ok: true, preview} : {ok: false, code: "not_found", message: "Stack not found."};
}
