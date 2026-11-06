import http from "node:http";
import https from "node:https";
import {isIP} from "node:net";
import type {VettedTarget} from "@/fork/net/guard";

/**
 * The only HTTP transport of the Arcane client (W05, SEC-10). GET only. It connects to the address the guard vetted
 * (`target.ip`) through a forced `lookup`: the name is never resolved again, so DNS rebinding between "check" and "use"
 * can not redirect the request. SNI, `Host` and certificate verification keep using the original host name.
 *  - no redirects: any 3xx is refused (an Arcane API never redirects; following one would re-enter the SSRF surface);
 *  - TLS verification is on; `tlsInsecure` is the per-connection opt-out (callers audit it);
 *  - total deadline + response size cap; no keep-alive pooling (`agent: false`), so a pooled socket can never outlive its vetting;
 *  - error messages carry a class only — never the URL, query, headers or body.
 */
export type TransportErrorCode = "timeout" | "network" | "tls" | "redirect" | "too_large" | "bad_content_type";

export class TransportError extends Error {
    constructor(public readonly code: TransportErrorCode, message: string) {
        super(message);
        this.name = "TransportError";
    }
}

export type PinnedRequestInit = {
    target: Pick<VettedTarget, "scheme" | "hostname" | "port" | "ip" | "family" | "baseUrl">;
    /** path + optional query, starting with `/` (appended to the base path of the URL). */
    path: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxBytes?: number;
    tlsInsecure?: boolean;
};

export type PinnedResponse = {status: number; headers: Record<string, string | string[] | undefined>; body: string};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const TLS_CODES = new Set([
    "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH", "CERT_REVOKED", "ERR_SSL_WRONG_VERSION_NUMBER",
]);

export function pinnedGet(init: PinnedRequestInit): Promise<PinnedResponse> {
    const {target} = init;
    const basePath = new URL(target.baseUrl).pathname.replace(/\/+$/, "");
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
    const mod = target.scheme === "https" ? https : http;

    return new Promise<PinnedResponse>((resolve, reject) => {
        let settled = false;
        const done = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };
        const lookup = ((_host: string, opts: {all?: boolean}, cb: (...a: unknown[]) => void) => {
            if (opts?.all) cb(null, [{address: target.ip, family: target.family}]);
            else cb(null, target.ip, target.family);
        }) as unknown as http.RequestOptions["lookup"];

        const req = mod.request(
            {
                hostname: target.hostname,
                port: target.port,
                path: `${basePath}${init.path}`,
                method: "GET",
                headers: {accept: "application/json", ...init.headers},
                agent: false,
                lookup,
                ...(target.scheme === "https" ? {servername: isIP(target.hostname) ? undefined : target.hostname, rejectUnauthorized: !init.tlsInsecure} : {}),
            },
            (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400) {
                    res.destroy();
                    return done(() => reject(new TransportError("redirect", "The Arcane server answered with a redirect, which is never followed.")));
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (c: Buffer) => {
                    size += c.length;
                    if (size > maxBytes) {
                        res.destroy();
                        return done(() => reject(new TransportError("too_large", "The Arcane response is larger than the allowed limit.")));
                    }
                    chunks.push(c);
                });
                res.on("end", () => {
                    const ct = String(res.headers["content-type"] ?? "").toLowerCase();
                    const body = Buffer.concat(chunks).toString("utf8");
                    if (status >= 200 && status < 300 && !ct.includes("json")) {
                        return done(() => reject(new TransportError("bad_content_type", "The Arcane server did not answer with JSON.")));
                    }
                    done(() => resolve({status, headers: res.headers, body}));
                });
                res.on("error", () => done(() => reject(new TransportError("network", "The connection to Arcane was interrupted."))));
            },
        );
        const timer = setTimeout(() => {
            req.destroy();
            done(() => reject(new TransportError("timeout", "The Arcane server did not answer in time.")));
        }, timeoutMs);
        timer.unref?.();
        req.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code && TLS_CODES.has(e.code)) return done(() => reject(new TransportError("tls", "The TLS certificate of the Arcane server could not be verified.")));
            done(() => reject(new TransportError("network", "The Arcane server could not be reached.")));
        });
        req.end();
    });
}
