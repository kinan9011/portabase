import type {ForkMode} from "@/fork/mode";

/**
 * Fork background work registers here (never in upstream `cron.ts`, so P03 is not needed in W01).
 * - plane "runtime": activated schedules, RP finalisation, drift job, notifications → started in
 *   "on" AND "locked" (degraded mode: never silently unscheduled, §4.1).
 * - plane "config":  discovery sync, anything that changes configuration → started in "on" only.
 * - mode "off": nothing is started.
 */
export type ForkRuntimeTask = {
    name: string;
    plane: "runtime" | "config";
    start: () => void | Promise<void>;
};

const KEY = Symbol.for("portabase.fork.tasks.v1");
function tasks(): ForkRuntimeTask[] {
    const g = globalThis as unknown as Record<symbol, ForkRuntimeTask[] | undefined>;
    g[KEY] ??= [];
    return g[KEY] as ForkRuntimeTask[];
}

export function registerForkRuntimeTask(task: ForkRuntimeTask) {
    const list = tasks();
    if (list.some((t) => t.name === task.name)) throw new Error(`fork runtime task already registered: ${task.name}`);
    list.push(task);
}

export const clearForkRuntimeTasks = () => {
    tasks().length = 0;
};

export function tasksForMode(mode: ForkMode): ForkRuntimeTask[] {
    if (mode === "off") return [];
    return tasks().filter((t) => mode === "on" || t.plane === "runtime");
}

/** Starts the tasks allowed in `mode`; a failing task is reported, never aborts the others or boot. */
export async function startForkRuntime(mode: ForkMode): Promise<{ started: string[]; failed: { name: string; error: string }[] }> {
    const started: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const t of tasksForMode(mode)) {
        try {
            await t.start();
            started.push(t.name);
        } catch (e) {
            failed.push({name: t.name, error: e instanceof Error ? e.message : String(e)});
        }
    }
    return {started, failed};
}
