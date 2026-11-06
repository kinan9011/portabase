import {NextResponse} from "next/server";

/**
 * SEC-16: CSRF protection for state-changing `/api/fork/*` handlers. Session cookies are SameSite-lax at best and the
 * proxy does not police origins for fork routes, so every unsafe request must prove it is same-origin:
 *   1. `Sec-Fetch-Site` (browsers always send it) must be `same-origin` — or `none` (user-initiated, never a form post
 *      from another site); `cross-site` / `same-site` are refused;
 *   2. otherwise `Origin` must equal the request's own origin or the configured public origin (`PROJECT_URL`);
 *   3. neither header present ⇒ refused (a browser would have sent one; no-header clients must not carry cookies);
 *   4. bodies must be `application/json` (a non-simple content type forces a CORS preflight, which we never grant).
 * Cookie-less bearer clients (the R2 agent channel, W15) are not CSRF-able and authenticate by credential instead;
 * they must NOT call this guard with a session. Safe methods are not checked and must not mutate.
 *
 * Usage in a route handler:  `const denied = forkCsrfGuard(req); if (denied) return denied;`
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export type CsrfVerdict = {ok: true} | {ok: false; reason: "cross-site" | "origin-mismatch" | "no-origin" | "content-type"};

const originOf = (u: string | null | undefined) => {
    try {
        return u ? new URL(u).origin : null;
    } catch {
        return null;
    }
};

export function checkForkCsrf(req: Request, env: Record<string, string | undefined> = process.env): CsrfVerdict {
    if (SAFE.has(req.method.toUpperCase())) return {ok: true};
    const fetchSite = req.headers.get("sec-fetch-site");
    if (fetchSite) {
        if (fetchSite !== "same-origin" && fetchSite !== "none") return {ok: false, reason: "cross-site"};
    } else {
        const origin = req.headers.get("origin");
        if (!origin) return {ok: false, reason: "no-origin"};
        const allowed = new Set([originOf(req.url), originOf(env.PROJECT_URL)].filter((x): x is string => !!x));
        if (!allowed.has(originOf(origin) ?? "\0")) return {ok: false, reason: "origin-mismatch"};
    }
    const hasBody = req.headers.has("content-length") ? req.headers.get("content-length") !== "0" : req.headers.has("transfer-encoding");
    const ct = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if ((hasBody || ct) && ct !== "application/json") return {ok: false, reason: "content-type"};
    return {ok: true};
}

/** Returns a 403 response when the request fails the check, else null. The body carries no detail beyond a generic code. */
export function forkCsrfGuard(req: Request, env?: Record<string, string | undefined>): NextResponse | null {
    const v = checkForkCsrf(req, env);
    return v.ok ? null : NextResponse.json({message: "Request rejected.", status: 403}, {status: 403});
}
