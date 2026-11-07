import {describe, expect, it} from "vitest";
import {ARCANE_ERROR_CLASSES, HEALTH_FOR_CLASS} from "@/fork/arcane/errors";
import {HEALTH_STATUSES} from "@/fork/db/enums";
import {connectionAlert, deriveConnectionState} from "@/fork/ui/integrations/connection-state";
import {CONNECTION_STATES} from "@/fork/ui/labels";

describe("deriveConnectionState (ADR-012 S7 → 9 UI states)", () => {
    it("no row = not configured; transient wins", () => {
        expect(deriveConnectionState(null)).toBe("not_configured");
        expect(deriveConnectionState(null, "testing")).toBe("testing");
        expect(deriveConnectionState({healthStatus: "healthy", lastErrorClass: null}, "syncing")).toBe("syncing");
    });
    it("healthy = connected; never connected unless healthy", () => {
        expect(deriveConnectionState({healthStatus: "healthy", lastErrorClass: null})).toBe("connected");
        for (const c of ARCANE_ERROR_CLASSES) expect(deriveConnectionState({healthStatus: HEALTH_FOR_CLASS[c], lastErrorClass: c})).not.toBe("connected");
    });
    const table: [string, string, string][] = [
        ["auth_failed", "invalid_key", "invalid_credentials"], ["auth_failed", "key_too_broad", "invalid_credentials"], ["auth_failed", "key_unverifiable", "invalid_credentials"],
        ["degraded", "permission", "insufficient_permission"], ["degraded", "partial", "partial_sync"], ["degraded", "not_found", "partial_sync"],
        ["unreachable", "unreachable", "unreachable"], ["unreachable", "tls", "unreachable"], ["unreachable", "blocked_url", "unreachable"], ["degraded", "rate_limited", "unreachable"],
        ["degraded", "incompatible", "incompatible_api"], ["degraded", "bad_response", "incompatible_api"],
    ];
    it.each(table)("%s + %s → %s", (h, c, s) => {
        expect(deriveConnectionState({healthStatus: h as never, lastErrorClass: c})).toBe(s);
    });
    it("every W05 error class maps (no class falls through)", () => {
        const mapped = new Set(table.map((t) => t[1]));
        for (const c of ARCANE_ERROR_CLASSES) expect(mapped.has(c)).toBe(true);
    });
    it("status without a class: own state; unknown = testing (never verified), junk class ignored", () => {
        expect(deriveConnectionState({healthStatus: "degraded", lastErrorClass: null})).toBe("partial_sync");
        expect(deriveConnectionState({healthStatus: "unreachable", lastErrorClass: null})).toBe("unreachable");
        expect(deriveConnectionState({healthStatus: "auth_failed", lastErrorClass: null})).toBe("invalid_credentials");
        expect(deriveConnectionState({healthStatus: "unknown", lastErrorClass: null})).toBe("testing");
        expect(deriveConnectionState({healthStatus: "unreachable", lastErrorClass: "__proto__"})).toBe("unreachable");
        expect(deriveConnectionState({healthStatus: "healthy", lastErrorClass: "constructor"})).toBe("connected");
    });
    it("all 9 states are reachable from persisted facts + transients", () => {
        const reached = new Set<string>([deriveConnectionState(null), deriveConnectionState(null, "testing"), deriveConnectionState({healthStatus: "healthy", lastErrorClass: null}), deriveConnectionState({healthStatus: "healthy", lastErrorClass: null}, "syncing")]);
        for (const [h, c] of table) reached.add(deriveConnectionState({healthStatus: h as never, lastErrorClass: c}));
        expect([...reached].sort()).toEqual([...CONNECTION_STATES].sort());
    });
    it("all 5 persisted statuses are handled", () => {
        for (const h of HEALTH_STATUSES) expect(CONNECTION_STATES).toContain(deriveConnectionState({healthStatus: h, lastErrorClass: null}));
    });
});

describe("connectionAlert (error copy per state, UX-19)", () => {
    it("no alert for not configured / testing / connected / syncing", () => {
        for (const s of ["not_configured", "testing", "connected", "syncing"] as const) expect(connectionAlert(s, null)).toBeNull();
    });
    it("every problem state × its classes has a specific title and body", () => {
        for (const [h, c, s] of table2()) {
            const a = connectionAlert(deriveConnectionState({healthStatus: h as never, lastErrorClass: c}), c);
            expect(a?.title, `${s}/${c}`).toBeTruthy();
            expect(a?.body).toBeTruthy();
            expect(a?.errorClass).toBe(c);
        }
    });
    it("state without matching class falls back to the state's own description", () => {
        const a = connectionAlert("unreachable", null);
        expect(a?.title).toBe("Unreachable");
        expect(a?.errorClass).toBeNull();
    });
});
function table2(): [string, string, string][] {
    return ARCANE_ERROR_CLASSES.map((c) => [HEALTH_FOR_CLASS[c], c, deriveConnectionState({healthStatus: HEALTH_FOR_CLASS[c], lastErrorClass: c})]);
}
