import {PROTECTION_STATES, RUNTIME_STATES} from "@/fork/db/enums";

/**
 * Search params of the Docker Stacks list (W08). Everything arrives from the URL, so everything is untrusted: each value is
 * validated against a closed set or bounded, and anything invalid falls back to the default instead of failing the page.
 * The values are only ever passed to SQL as bind parameters (see `queries.ts`).
 */
export const PAGE_SIZE = 25;
export const MAX_PAGE = 10_000;
export const MAX_QUERY_LENGTH = 100;
export const MAX_ENVIRONMENT_LENGTH = 128;
export const SORTS = ["name", "attention", "updated"] as const;
export type StackSort = (typeof SORTS)[number];

export type StackListParams = {
    q: string;
    environment: string | null;
    runtime: (typeof RUNTIME_STATES)[number] | null;
    protection: (typeof PROTECTION_STATES)[number] | null;
    sort: StackSort;
    page: number;
};

export const DEFAULT_PARAMS: StackListParams = {q: "", environment: null, runtime: null, protection: null, sort: "name", page: 1};

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const clean = (s: string, max: number) => {
    let out = "";
    for (const ch of s.normalize("NFC")) { const c = ch.charCodeAt(0); if (c >= 32 && c !== 127) out += ch; if (out.length >= max) break; }
    return out.trim();
};

export function parseStackListParams(raw: Raw): StackListParams {
    const q = clean(one(raw.q) ?? "", MAX_QUERY_LENGTH);
    const env = clean(one(raw.environment) ?? "", MAX_ENVIRONMENT_LENGTH);
    const runtime = one(raw.runtime);
    const protection = one(raw.protection);
    const sort = one(raw.sort);
    const pageNum = Number.parseInt(one(raw.page) ?? "1", 10);
    return {
        q,
        environment: env || null,
        runtime: (RUNTIME_STATES as readonly string[]).includes(runtime ?? "") ? (runtime as StackListParams["runtime"]) : null,
        protection: (PROTECTION_STATES as readonly string[]).includes(protection ?? "") ? (protection as StackListParams["protection"]) : null,
        sort: (SORTS as readonly string[]).includes(sort ?? "") ? (sort as StackSort) : "name",
        page: Number.isFinite(pageNum) && pageNum >= 1 ? Math.min(pageNum, MAX_PAGE) : 1,
    };
}

export const isFiltered = (p: StackListParams) => p.q !== "" || p.environment !== null || p.runtime !== null || p.protection !== null;

/** Query string for links (omits defaults so URLs stay short and stable). */
export function toQueryString(p: Partial<StackListParams>): string {
    const u = new URLSearchParams();
    if (p.q) u.set("q", p.q);
    if (p.environment) u.set("environment", p.environment);
    if (p.runtime) u.set("runtime", p.runtime);
    if (p.protection) u.set("protection", p.protection);
    if (p.sort && p.sort !== "name") u.set("sort", p.sort);
    if (p.page && p.page > 1) u.set("page", String(p.page));
    const s = u.toString();
    return s ? `?${s}` : "";
}

/** `%`, `_` and `\` are LIKE metacharacters: a search for "50%" must match the text "50%", not everything. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
