import {execFile} from "node:child_process";
import {chmod, mkdir, readdir, rm} from "node:fs/promises";
import path from "node:path";

/**
 * pg_dump taken before the fork lane applies pending migrations (ADR-003 rollback story:
 * rollback = restore this dump; fork migrations are forward-only).
 *
 * Secrets: password goes through the PGPASSWORD env var of the child (never argv, never logged);
 * the dump (it contains the whole dashboard DB incl. encrypted secrets) lives in a 0700 directory
 * with 0600 files, keeping only the newest `keep`.
 */
export type DumpOptions = {
    databaseUrl: string;
    dir: string;
    bin?: string;
    keep?: number;
    timeoutMs?: number;
    now?: () => Date;
    /** test seam */
    exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>;
};

const PREFIX = "portabase-pre-fork-migrate-";

const defaultExec: NonNullable<DumpOptions["exec"]> = (bin, args, env, timeoutMs) =>
    new Promise((resolve, reject) => {
        execFile(bin, args, {env, timeout: timeoutMs, windowsHide: true}, (err, _out, stderr) => {
            if (err) reject(new Error(`pg_dump failed: ${(stderr || err.message).toString().slice(0, 500)}`));
            else resolve();
        });
    });

export function dumpArgsFromUrl(databaseUrl: string, file: string): { args: string[]; env: NodeJS.ProcessEnv } {
    const u = new URL(databaseUrl);
    // Minimal child env: never hand the dashboard's own secrets (PROJECT_SECRET, SMTP_*, ...) to pg_dump.
    const env = {} as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(process.env)) if (k === "PATH" || k === "LANG" || k === "TZ" || k.startsWith("PG")) env[k] = v;
    if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
    const sslmode = u.searchParams.get("sslmode");
    if (sslmode) env.PGSSLMODE = sslmode;
    const args = ["--format=custom", "--no-password", "--file", file];
    if (u.hostname) args.push("--host", u.hostname);
    if (u.port) args.push("--port", u.port);
    if (u.username) args.push("--username", decodeURIComponent(u.username));
    args.push("--dbname", decodeURIComponent(u.pathname.replace(/^\//, "")));
    return {args, env};
}

export async function preMigrationDump(o: DumpOptions): Promise<string> {
    await mkdir(o.dir, {recursive: true, mode: 0o700});
    await chmod(o.dir, 0o700);
    const stamp = (o.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const file = path.join(o.dir, `${PREFIX}${stamp}.dump`);
    const {args, env} = dumpArgsFromUrl(o.databaseUrl, file);
    await (o.exec ?? defaultExec)(o.bin ?? "pg_dump", args, env, o.timeoutMs ?? 10 * 60_000);
    await chmod(file, 0o600);
    const keep = o.keep ?? 3;
    const files = (await readdir(o.dir)).filter((f) => f.startsWith(PREFIX)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - keep))) await rm(path.join(o.dir, old), {force: true});
    return file;
}
