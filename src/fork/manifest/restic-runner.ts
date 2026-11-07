import {spawn} from "node:child_process";

/**
 * Minimal binary-safe restic runner (the manifest repo holds a RAW binary signature, so stdout must not pass through a string). The password and the
 * rclone config reach restic only through the child environment / a 0600 temp file, never argv (ADR-007 input note: argv is visible in /proc). Output
 * limits keep a hostile or broken repo from exhausting memory.
 */
export type ResticResult = {code: number; stdout: Buffer; stderr: string};
export type ResticRunner = (args: readonly string[], o?: {cwd?: string; timeoutMs?: number; maxStdoutBytes?: number}) => Promise<ResticResult>;

export type RunnerConfig = {
    repository: string;
    password: string;
    /** extra environment (e.g. RCLONE_CONFIG, RESTIC_CACHE_DIR); inherited process env is NOT passed through except PATH/HOME-less minimum */
    env?: Record<string, string>;
    binary?: string;
    extraArgs?: readonly string[];
};

const DEFAULT_TIMEOUT = 5 * 60_000;
const DEFAULT_STDOUT = 64 * 1024 * 1024;

export function createResticRunner(cfg: RunnerConfig): ResticRunner {
    return (args, o = {}) => new Promise<ResticResult>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...cfg.env, RESTIC_REPOSITORY: cfg.repository, RESTIC_PASSWORD: cfg.password};
        const child = spawn(cfg.binary ?? "restic", [...args, "--retry-lock", "1m", ...(cfg.extraArgs ?? [])], {env, cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"]});
        const out: Buffer[] = [];
        let outBytes = 0;
        let err = "";
        const cap = o.maxStdoutBytes ?? DEFAULT_STDOUT;
        const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs ?? DEFAULT_TIMEOUT);
        child.stdout.on("data", (c: Buffer) => { outBytes += c.length; if (outBytes > cap) { child.kill("SIGKILL"); return; } out.push(c); });
        child.stderr.on("data", (c: Buffer) => { if (err.length < 8192) err += c.toString(); });
        child.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(e.code === "ENOENT" ? new Error("restic binary not found") : new Error("restic could not start")); });
        child.on("close", (code) => { clearTimeout(timer); resolve({code: code ?? -1, stdout: Buffer.concat(out), stderr: err.trim()}); });
    });
}

/** restic exit codes (0.18): 10 = repository does not exist, 11 = locked, 12 = wrong password. */
export const RESTIC_NO_REPO = 10;
export const RESTIC_WRONG_PASSWORD = 12;
