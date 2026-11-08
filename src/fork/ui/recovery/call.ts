/** Normalises a next-safe-action result: the service's own `{ok, ...}` verdict, or a closed "failed" outcome (never a raw server error). */
export type SafeResult = {data?: unknown; serverError?: unknown; validationErrors?: unknown} | undefined;
export type Verdict = {ok: true; data: Record<string, unknown>} | {ok: false; code: string};

export function verdict(r: SafeResult): Verdict {
    if (!r || r.serverError || r.validationErrors || !r.data || typeof r.data !== "object") return {ok: false, code: "failed"};
    const d = r.data as {ok?: unknown; code?: unknown};
    return d.ok === true ? {ok: true, data: d as Record<string, unknown>} : {ok: false, code: typeof d.code === "string" ? d.code : "failed"};
}
