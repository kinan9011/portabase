import {NextResponse} from "next/server";
import {appDb} from "@/fork/db/handle";
import {forkEnv} from "@/fork/env";
import {currentForkMode} from "@/fork/mode";
import {authenticateAgent, type Enrollment} from "./auth";
import {MAX_BODY_BYTES} from "./vocab";

/** Shared plumbing of the four agent routes: flags-off parity (404), bounded JSON body, authentication, uniform error bodies. No cookies, no CSRF (bearer API). */
const NO_STORE = {"Cache-Control": "no-store"};
export const json = (body: unknown, status: number, extra: Record<string, string> = {}) => NextResponse.json(body, {status, headers: {...NO_STORE, ...extra}});
export const notFound = () => json({message: "This API route does not exist.", status: 404}, 404);

export async function readJsonBody(req: Request, o: {maxBytes?: number} = {}): Promise<{ok: true; body: unknown} | {ok: false}> {
    const max = o.maxBytes ?? MAX_BODY_BYTES;
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return {ok: false};
    if (Number(req.headers.get("content-length") ?? 0) > max) return {ok: false};
    try {
        const text = await req.text();
        if (Buffer.byteLength(text) > max) return {ok: false};
        return {ok: true, body: text.length ? JSON.parse(text) : {}};
    } catch { return {ok: false}; }
}

const sourceOf = (req: Request) => (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);

export async function withAgent(req: Request, agentId: string, fn: (a: {enrollment: Enrollment; organizationId: string | null; db: Awaited<ReturnType<typeof appDb>>}) => Promise<Response>): Promise<Response> {
    if ((await currentForkMode()).mode === "off") return notFound();
    const db = await appDb();
    const auth = await authenticateAgent(db, {agentId, authorization: req.headers.get("authorization"), source: sourceOf(req)});
    if (!auth.ok) {
        if (auth.status === 429) return json({code: auth.code}, 429, {"Retry-After": String(auth.retryAfterSeconds ?? 1)});
        return json({code: auth.code}, auth.status);
    }
    return fn({enrollment: auth.enrollment, organizationId: auth.organizationId, db});
}

export const leaseSeconds = () => forkEnv().FORK_AGENT_LEASE_SECONDS;
