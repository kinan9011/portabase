/** Normalises a next-safe-action result: the service's own `{ok, ...}` verdict, or a closed "failed" outcome (never a raw server error). */
export type SafeResult = {data?: unknown; serverError?: unknown; validationErrors?: unknown} | undefined;
export type Verdict<T> = {ok: true; data: T} | {ok: false; code: string};

export function verdict<T extends {ok: boolean}>(r: SafeResult): Verdict<Extract<T, {ok: true}>> {
    if (!r || r.serverError || r.validationErrors || !r.data) return {ok: false, code: "failed"};
    const d = r.data as {ok: boolean; code?: string};
    return d.ok ? {ok: true, data: d as Extract<T, {ok: true}>} : {ok: false, code: typeof d.code === "string" ? d.code : "failed"};
}
