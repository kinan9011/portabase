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

export function forkRoutePatterns(source: Record<string, string | undefined> = process.env): RegExp[] {
    return anyForkFlagOn(source) ? [...CONFIG_ROUTES, ...RUNTIME_ROUTES] : [...RUNTIME_ROUTES];
}
