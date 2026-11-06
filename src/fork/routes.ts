import {forkCan} from "@/fork/acl";
import {anyForkFlagOn} from "@/fork/env";

/**
 * `proxy.ts` hook (P04): fork API routes the upstream `checkRouteExists()` allowlist must pass.
 * - CONFIG routes are allowed only when a flag is on (flags off ⇒ every /api/fork/* is a 404 JSON).
 * - RUNTIME routes (e.g. the R2 agent task channel, W15) must stay reachable in "locked" mode,
 *   so they are listed separately and always allowed; their handlers return 404 when mode is "off".
 *   Empty in W01 on purpose.
 * Each handler still authorises itself; the allowlist is not a permission check.
 */
const CONFIG_ROUTES: RegExp[] = [/^\/api\/fork\//];
const RUNTIME_ROUTES: RegExp[] = [];

/**
 * `proxy.ts` hook (P04, `/dashboard` branch): fork PAGES that must answer with a real HTTP 404 (the
 * dashboard's `loading.tsx` makes a page-level `notFound()` stream as status 200).
 * Hidden unless a flag is on AND the viewer is a system admin. Pages re-check mode + ACL themselves
 * (locked mode needs the DB, which proxy must not touch).
 */
const ADMIN_PAGES: RegExp[] = [/^\/dashboard\/integrations(\/|$)/];

export function forkPageHidden(pathname: string, role: string | null | undefined, source: Record<string, string | undefined> = process.env): boolean {
    if (!ADMIN_PAGES.some((r) => r.test(pathname))) return false;
    return !(anyForkFlagOn(source) && forkCan({systemRole: role}, "arcane.manage"));
}

export function forkRoutePatterns(source: Record<string, string | undefined> = process.env): RegExp[] {
    return anyForkFlagOn(source) ? [...CONFIG_ROUTES, ...RUNTIME_ROUTES] : [...RUNTIME_ROUTES];
}
