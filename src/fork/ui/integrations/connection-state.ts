import type {ArcaneErrorClass} from "@/fork/arcane/errors";
import {CONNECTION_ERROR_COPY, CONNECTION_STATE_LABELS, type AlertCopy, type ConnectionState} from "@/fork/ui/labels";
import type {Tone} from "@/fork/ui/tone";

/** The persisted facts the UI state is derived from (the non-secret part of `ConnectionDto`). */
export type ConnectionHealthFacts = {healthStatus: "unknown" | "healthy" | "degraded" | "unreachable" | "auth_failed"; lastErrorClass: string | null};
/** Transient, client-side only: a pending test/save/rotate is `testing`; `syncing` is supplied by W07's sync, never invented here. */
export type TransientState = "testing" | "syncing" | null | undefined;

const BY_CLASS: Record<ArcaneErrorClass, ConnectionState> = {
    invalid_key: "invalid_credentials",
    key_too_broad: "invalid_credentials",
    key_unverifiable: "invalid_credentials",
    permission: "insufficient_permission",
    partial: "partial_sync",
    not_found: "partial_sync",
    unreachable: "unreachable",
    tls: "unreachable",
    blocked_url: "unreachable",
    rate_limited: "unreachable",
    incompatible: "incompatible_api",
    bad_response: "incompatible_api",
};

const isClass = (c: string | null): c is ArcaneErrorClass => c !== null && Object.hasOwn(BY_CLASS, c);

/**
 * 9 UI states from (health_status, last_error_class) — ADR-012 S7. Never throws, never says "Connected" unless the last
 * check was healthy. An unknown class on a failing status falls back to the status' own state (honest, not "Connected").
 */
export function deriveConnectionState(conn: ConnectionHealthFacts | null, transient?: TransientState): ConnectionState {
    if (transient) return transient;
    if (!conn) return "not_configured";
    if (isClass(conn.lastErrorClass) && conn.healthStatus !== "healthy") return BY_CLASS[conn.lastErrorClass];
    switch (conn.healthStatus) {
        case "healthy": return "connected";
        case "degraded": return "partial_sync";
        case "unreachable": return "unreachable";
        case "auth_failed": return "invalid_credentials";
        default: return "testing"; // `unknown`: stored but never verified (see CONNECTION_STATE_LABELS.testing)
    }
}

export type ConnectionAlert = AlertCopy & {tone: Tone; errorClass: ArcaneErrorClass | null};

/** Alert for the problem states; `null` for not configured / testing / connected / syncing. */
export function connectionAlert(state: ConnectionState, errorClass: string | null): ConnectionAlert | null {
    if (state === "not_configured" || state === "testing" || state === "connected" || state === "syncing") return null;
    const tone = CONNECTION_STATE_LABELS[state].tone;
    if (isClass(errorClass) && BY_CLASS[errorClass] === state) return {...CONNECTION_ERROR_COPY[errorClass], tone, errorClass};
    // state reached without a matching class (e.g. degraded with no class): say what the state means, not more
    return {title: CONNECTION_STATE_LABELS[state].label, body: CONNECTION_STATE_LABELS[state].description, tone, errorClass: null};
}
