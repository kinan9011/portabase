import type {HEALTH_STATUSES} from "@/fork/db/enums";

/**
 * Arcane error classes (W05, ADR-002 §2 → connection state). Messages are fixed strings per class (+ the exact
 * permission name for a 403, which Arcane names in `detail`) — never a URL, query, header or response body (B2/SEC-10).
 */
export const ARCANE_ERROR_CLASSES = [
    "invalid_key", // 401
    "permission", // 403 or a missing grant
    "key_too_broad", // self-test: the key holds more than the list-only minimum
    "key_unverifiable", // self-test: own key row not found
    "unreachable", // network / timeout / 5xx after retries
    "tls", // certificate could not be verified
    "blocked_url", // SSRF guard
    "rate_limited", // 429 beyond the retry budget
    "incompatible", // Arcane version differs from the pinned contract
    "partial", // some allowed environment lacks a list permission
    "bad_response", // unexpected format / redirect / non-JSON / too large
    "not_found",
] as const;
export type ArcaneErrorClass = (typeof ARCANE_ERROR_CLASSES)[number];

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** error class → persisted `health_status` (W04 CHECK set). The class itself goes to `last_error_class`; W06 renders the 9 UI states from both. */
export const HEALTH_FOR_CLASS: Record<ArcaneErrorClass, HealthStatus> = {
    invalid_key: "auth_failed",
    key_too_broad: "auth_failed",
    key_unverifiable: "auth_failed",
    permission: "degraded",
    partial: "degraded",
    incompatible: "degraded",
    bad_response: "degraded",
    not_found: "degraded",
    rate_limited: "degraded",
    unreachable: "unreachable",
    tls: "unreachable",
    blocked_url: "unreachable",
};

const MESSAGES: Record<ArcaneErrorClass, string> = {
    invalid_key: "Arcane rejected the API key (401). Check the key or rotate it.",
    permission: "The Arcane key lacks a required permission.",
    key_too_broad: "The Arcane key holds more permissions than the discovery minimum.",
    key_unverifiable: "The key's own permissions could not be read from Arcane.",
    unreachable: "Arcane could not be reached.",
    tls: "The TLS certificate of the Arcane server could not be verified.",
    blocked_url: "The Arcane URL is not allowed.",
    rate_limited: "Arcane is rate limiting requests; try again later.",
    incompatible: "This Arcane version is not the one this release was tested against.",
    partial: "The Arcane key does not cover every environment completely.",
    bad_response: "Arcane answered in an unexpected format.",
    not_found: "Arcane does not know that resource.",
};

export class ArcaneError extends Error {
    readonly status?: number;
    readonly permission?: string;
    readonly permissions?: string[];
    constructor(public readonly errorClass: ArcaneErrorClass, o: {status?: number; permission?: string; permissions?: string[]; message?: string} = {}) {
        super(o.message ?? MESSAGES[errorClass]);
        this.name = "ArcaneError";
        this.status = o.status;
        this.permission = o.permission;
        this.permissions = o.permissions;
    }
    get health(): HealthStatus {
        return HEALTH_FOR_CLASS[this.errorClass];
    }
}

/** Arcane's 403 `detail` is `permission denied: <permission>`; only a strictly shaped token is ever surfaced. */
export function permissionFromDetail(body: string): string | undefined {
    try {
        const j = JSON.parse(body) as {detail?: unknown};
        const m = typeof j.detail === "string" ? /^permission denied: ([a-z_]{1,40}:[a-z_]{1,40})$/.exec(j.detail) : null;
        return m?.[1];
    } catch {
        return undefined;
    }
}
