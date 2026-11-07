import {GENERIC_FAILURE, REFUSAL_COPY} from "@/fork/ui/labels";

/** What a server-action call resolves to (never throws for server answers; carries no input, so no password). Same shape as the W06 helper, kept local so this page does not import the Integrations actions. */
export type UiResult<T> = {kind: "ok"; outcome: T} | {kind: "refused"; code: string; message: string; outcome: Extract<T, {ok: false}>} | {kind: "error"; message: string};
type SafeActionResult<T> = {data?: T; serverError?: unknown; validationErrors?: unknown} | undefined;

export function normalise<T extends {ok: boolean}>(r: SafeActionResult<T>): UiResult<T> {
    if (!r || r.serverError || r.validationErrors || !r.data) return {kind: "error", message: r?.validationErrors ? REFUSAL_COPY.invalid_input : GENERIC_FAILURE};
    const o = r.data as T & {ok: boolean; code?: string; message?: string};
    if (o.ok) return {kind: "ok", outcome: r.data};
    return {kind: "refused", code: o.code ?? "refused", message: o.message || REFUSAL_COPY[o.code ?? "refused"] || GENERIC_FAILURE, outcome: r.data as Extract<T, {ok: false}>};
}
