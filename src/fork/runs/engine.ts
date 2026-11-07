/**
 * Small durable step engine (ARCH-13). Used by W12 stack runs and (later) the W18 restore orchestrator ONLY — there are no mirror
 * steps (R3 is optional and gets its own design if it ever opens; `w12-runs-static` greps for the vocabulary).
 *
 * Contract:
 *  - the step list is plain data (`StepRecord[]`) that the caller persists (a jsonb column) — a crash resumes from the last persisted
 *    state, so a handler MUST be idempotent (it may run again after a crash between "work done" and "persist");
 *  - `advanceSteps` runs steps strictly in order; `wait` keeps the current step open and returns (the next tick polls again);
 *    `fail` ends the whole sequence; a thrown error is counted and retried up to `maxErrors` consecutive times, then it fails with
 *    the fixed code `internal_error` (the message is never stored: it could carry secrets);
 *  - state is persisted through `persist` after EVERY state change, never only at the end;
 *  - time comes from the caller (`now`), so every test runs on a fake clock.
 */
export type StepStatus = "pending" | "running" | "done" | "failed";
export type StepRecord<N extends string = string> = {
    name: N;
    status: StepStatus;
    /** invocations (a `wait` step is invoked once per tick) */
    attempts: number;
    /** consecutive thrown errors of the current step */
    errors: number;
    startedAt?: string;
    finishedAt?: string;
    /** fixed code of a failure */
    code?: string;
};

export type StepOutcome = {kind: "done"} | {kind: "wait"} | {kind: "fail"; code: string};
export const done = (): StepOutcome => ({kind: "done"});
export const wait = (): StepOutcome => ({kind: "wait"});
export const fail = (code: string): StepOutcome => ({kind: "fail", code});

export type StepHandler<C> = (ctx: C) => Promise<StepOutcome>;
export type Handlers<N extends string, C> = Record<N, StepHandler<C>>;

export const initialSteps = <N extends string>(names: readonly N[]): StepRecord<N>[] =>
    names.map((name) => ({name, status: "pending" as const, attempts: 0, errors: 0}));

export type AdvanceResult<N extends string> = {
    steps: StepRecord<N>[];
    /** `running` = a step is waiting/pending for the next tick; `done` = every step finished; `failed` = a step failed. */
    state: "running" | "done" | "failed";
    failedStep?: N;
    code?: string;
};

export const DEFAULT_MAX_ERRORS = 5;

export async function advanceSteps<N extends string, C>(
    input: readonly StepRecord<N>[], handlers: Handlers<N, C>, ctx: C,
    o: {now: () => Date; persist: (steps: StepRecord<N>[]) => Promise<void>; maxErrors?: number},
): Promise<AdvanceResult<N>> {
    const steps = input.map((s) => ({...s}));
    const maxErrors = o.maxErrors ?? DEFAULT_MAX_ERRORS;
    for (;;) {
        const bad = steps.find((s) => s.status === "failed");
        if (bad) return {steps, state: "failed", failedStep: bad.name, code: bad.code};
        const cur = steps.find((s) => s.status !== "done");
        if (!cur) return {steps, state: "done"};
        if (cur.status === "pending") {
            cur.status = "running";
            cur.startedAt = o.now().toISOString();
        }
        cur.attempts += 1;
        let outcome: StepOutcome;
        try {
            outcome = await handlers[cur.name](ctx);
            cur.errors = 0;
        } catch {
            cur.errors += 1;
            if (cur.errors >= maxErrors) outcome = fail("internal_error");
            else {
                await o.persist(steps);
                return {steps, state: "running"};
            }
        }
        if (outcome.kind === "wait") {
            await o.persist(steps);
            return {steps, state: "running"};
        }
        cur.finishedAt = o.now().toISOString();
        if (outcome.kind === "done") cur.status = "done";
        else {
            cur.status = "failed";
            cur.code = outcome.code;
        }
        await o.persist(steps);
    }
}

/** Marks every not-yet-finished step as failed with `code` (a cancelled or timed-out run). Pure. */
export function failRemaining<N extends string>(steps: readonly StepRecord<N>[], code: string, now: Date): StepRecord<N>[] {
    let first = true;
    return steps.map((s) => {
        if (s.status === "done" || s.status === "failed") return {...s};
        const r = {...s, status: "failed" as const, finishedAt: now.toISOString(), ...(first ? {code} : {})};
        first = false;
        return r;
    });
}
