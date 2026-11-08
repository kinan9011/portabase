import {forkCan} from "@/fork/acl";
import {anyForkFlagOn} from "@/fork/env";

/**
 * `proxy.ts` hook (P04): fork API routes the upstream `checkRouteExists()` allowlist must pass.
 * - CONFIG routes are allowed only when a flag is on (flags off ⇒ every /api/fork/* is a 404 JSON).
 * - RUNTIME routes (e.g. the R2 agent task channel, W15) must stay reachable in "locked" mode,
 *   so they are listed separately and always allowed; their handlers return 404 when mode is "off".
 *   W15: the four agent-channel routes (bearer-authenticated by the handler, no session).
 * Each handler still authorises itself; the allowlist is not a permission check.
 */
const CONFIG_ROUTES: RegExp[] = [/^\/api\/fork\//];
const RUNTIME_ROUTES: RegExp[] = [/^\/api\/fork\/agent\/[0-9a-f-]{36}\/(?:lease|hash-report|tasks\/[0-9a-f-]{36}\/(?:heartbeat|result|render|quiesce))\/?$/];

/**
 * `proxy.ts` hook (P04, `/dashboard` branch): fork PAGES that must answer with a real HTTP 404 (the
 * dashboard's `loading.tsx` makes a page-level `notFound()` stream as status 200).
 * Hidden unless a flag is on AND the viewer is a system admin. Pages re-check mode + ACL themselves
 * (locked mode needs the DB, which proxy must not touch).
 */
const ADMIN_PAGES: RegExp[] = [/^\/dashboard\/integrations(\/|$)/];
/** Member-visible fork pages (W08): hidden (real 404) whenever no fork flag is on; who may open them is decided by the page (org membership, `stacks.view`). */
const MEMBER_PAGES: RegExp[] = [/^\/dashboard\/stacks(\/|$)/, /^\/dashboard\/recovery(\/|$)/]; // W18b: Stack Recovery pages (D13)

export function forkPageHidden(pathname: string, role: string | null | undefined, source: Record<string, string | undefined> = process.env): boolean {
    if (MEMBER_PAGES.some((r) => r.test(pathname))) return !anyForkFlagOn(source);
    if (!ADMIN_PAGES.some((r) => r.test(pathname))) return false;
    return !(anyForkFlagOn(source) && forkCan({systemRole: role}, "arcane.manage"));
}

export function forkRoutePatterns(source: Record<string, string | undefined> = process.env): RegExp[] {
    // flags off ⇒ the fork is invisible (a real upstream 404 from the proxy); runtime routes exist for `on` AND `locked` mode, both of which need a flag
    return anyForkFlagOn(source) ? [...CONFIG_ROUTES, ...RUNTIME_ROUTES] : [];
}
