/** W27a SEC-09 canary helpers: per-run planted secrets, their encoded forms, and the sinks (DB dump, captured output). */
import {randomUUID} from "node:crypto";
import {vi} from "vitest";
import type {Pool} from "pg";

export const CANARY_KINDS = ["arcaneKey", "storageSecret", "envValue", "overrideValue", "overrideFile", "agentSecret", "kitPassphrase", "resultText", "labelValue"] as const;
export type Canaries = Record<(typeof CANARY_KINDS)[number], string>;

export function makeCanaries(): Canaries {
    const run = randomUUID().replace(/-/g, "");
    return Object.fromEntries(CANARY_KINDS.map((k) => [k, `CANARY-W27-${k}-${run}`])) as Canaries;
}

/** raw, base64, base64url, hex, URL-encoded. */
export function encodings(s: string): string[] {
    const b = Buffer.from(s, "utf8");
    return [s, b.toString("base64"), b.toString("base64url"), b.toString("hex"), encodeURIComponent(s)];
}

export function findCanary(haystack: string, canaries: Record<string, string>): string[] {
    const hits: string[] = [];
    for (const [kind, c] of Object.entries(canaries)) for (const form of encodings(c)) if (haystack.includes(form)) hits.push(`${kind} (${form === c ? "raw" : form.slice(0, 12) + "…"})`);
    return hits;
}

export function assertNoCanary(haystack: string, canaries: Record<string, string>, where: string): void {
    const hits = findCanary(haystack, canaries);
    if (hits.length) throw new Error(`canary leaked into ${where}: ${hits.join(", ")}`);
}

/** Every `fork_%` table as JSON text (every row, every column), so a table added later is scanned automatically. */
export async function dumpForkTables(pool: Pool, opts: {exclude?: string[]} = {}): Promise<string> {
    const tables = (await pool.query<{table_name: string}>("select table_name from information_schema.tables where table_schema='public' and table_name like 'fork\\_%' order by 1")).rows.map((r) => r.table_name).filter((n) => !opts.exclude?.includes(n));
    const out: string[] = [];
    for (const t of tables) out.push(`${t}: ${JSON.stringify((await pool.query(`select * from "${t}" order by 1`)).rows)}`);
    return out.join("\n");
}

/** console.* and process.stdout/stderr.write captured until `restore()`. */
export function captureOutput(): {text: () => string; restore: () => void} {
    const lines: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); }));
    const so = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { lines.push(String(c)); return true; }) as never);
    const se = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => { lines.push(String(c)); return true; }) as never);
    return {text: () => lines.join("\n"), restore: () => { for (const s of [...spies, so, se]) s.mockRestore(); }};
}
