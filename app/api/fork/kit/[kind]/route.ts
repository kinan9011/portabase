import {NextResponse} from "next/server";
import {appDb} from "@/fork/db/handle";
import {forkCsrfGuard} from "@/fork/route-guard";
import {fileKeyProvider} from "@/fork/keys";
import {generateKitArtifact} from "@/fork/kit/service";
import {currentForkMode} from "@/fork/mode";
import {getForkPrincipal} from "@/fork/principal";

/**
 * Kit delivery (W14, ADR-013 K-8). The ONLY place a recovery kit leaves the server, once, in ONE response:
 *  - session user only: a request that carries an API key / Authorization header is refused (this is not part of the public API or MCP surface);
 *  - same-origin JSON POST (CSRF guard), system administrator, a single-use grant from the step-up action, passphrase policy for the digital kit;
 *  - `Cache-Control: no-store` + `Pragma`/`Expires`, never cached, never logged, the body is the kit and nothing else;
 *  - the browser keeps it in memory only (client-side print view / one download) — see `src/fork/ui/kit/kit-generate.client.tsx`.
 * Errors carry a stable code and a plain sentence, never key material or the input.
 */
export const dynamic = "force-dynamic";
const NO_STORE = {"Cache-Control": "no-store, no-cache, max-age=0, must-revalidate", Pragma: "no-cache", Expires: "0", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow"};
const json = (body: unknown, status: number) => NextResponse.json(body, {status, headers: NO_STORE});
const STATUS: Record<string, number> = {forbidden: 403, locked: 423, rate_limited: 429, invalid_input: 400, token_invalid: 410, weak_passphrase: 422, unavailable: 503};

export async function POST(req: Request, ctx: {params: Promise<{kind: string}>}) {
    const denied = forkCsrfGuard(req);
    if (denied) return denied;
    if ((await currentForkMode()).mode === "off") return json({message: "This API route does not exist.", status: 404}, 404);
    if (req.headers.has("x-api-key") || req.headers.has("authorization")) return json({code: "forbidden", message: "The recovery kit is not available through the API."}, 403);
    const {kind} = await ctx.params;
    if (kind !== "paper" && kind !== "digital") return json({message: "This API route does not exist.", status: 404}, 404);
    if (Number(req.headers.get("content-length") ?? 0) > 8192) return json({code: "invalid_input", message: "The request is not valid."}, 413);
    let body: unknown;
    try { body = await req.json(); } catch { return json({code: "invalid_input", message: "The request is not valid."}, 400); }
    const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const r = await generateKitArtifact({db: await appDb(), principal: await getForkPrincipal(), keys: fileKeyProvider}, {kind, token: input.token, passphrase: input.passphrase, passphraseConfirm: input.passphraseConfirm});
    if (!r.ok) return json({code: r.code, message: r.message, retryAfterSeconds: r.retryAfterSeconds ?? null}, STATUS[r.code] ?? 400);
    return json(r.kind === "paper" ? {kind: "paper", html: r.body} : {kind: "digital", filename: r.filename, file: r.body}, 200);
}
