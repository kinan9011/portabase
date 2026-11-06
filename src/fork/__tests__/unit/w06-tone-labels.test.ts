import {describe, expect, it} from "vitest";
import {ARCANE_ERROR_CLASSES, HEALTH_FOR_CLASS} from "@/fork/arcane/errors";
import {HOST_ROLES} from "@/fork/db/enums";
import {CONNECTION_ERROR_COPY, CONNECTION_STATE_LABELS, CONNECTION_STATES, HOST_ROLE_LABELS, REFUSAL_COPY} from "@/fork/ui/labels";
import {TONE_MAP, TONES, type Tone} from "@/fork/ui/tone";
import {ARCANE_KEY_FIELD_COPY} from "@/fork/arcane/key-input-contract";

const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};
const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

describe("W06 tone map (AA in both themes, §8.2 rule 11)", () => {
    it("known reference ratios", () => {
        expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
        expect(contrast("#777777", "#ffffff")).toBeGreaterThan(4.4);
    });
    for (const tone of TONES) {
        for (const theme of ["light", "dark"] as const) {
            it(`${tone}/${theme}: text and body text on the tone background ≥ 4.5:1`, () => {
                const p = TONE_MAP[tone][theme];
                expect(contrast(p.fg, p.bg)).toBeGreaterThanOrEqual(4.5);
                expect(contrast(p.body, p.bg)).toBeGreaterThanOrEqual(4.5);
            });
        }
        it(`${tone}: classes encode exactly the audited hex pairs (no drift between classes and the table)`, () => {
            const t = TONE_MAP[tone];
            const hexes = (s: string) => [...s.matchAll(/#[0-9a-f]{6}/g)].map((m) => m[0]);
            for (const h of [t.light.fg, t.light.bg, t.light.border, t.dark.fg, t.dark.bg, t.dark.border]) expect(t.badge).toContain(h);
            expect(t.title).toContain(t.light.fg); expect(t.title).toContain(t.dark.fg);
            expect(t.body).toContain(t.light.body); expect(t.body).toContain(t.dark.body);
            expect(hexes(t.panel).sort()).toEqual([t.light.bg, t.light.border, t.dark.bg, t.dark.border].sort());
            expect(t.badge).toMatch(/dark:text-/);
        });
        it(`${tone}: has an icon (colour is never the only signal)`, () => expect(TONE_MAP[tone].iconKey).toBeTruthy());
    }
});

describe("W06 labels.ts (single source of copy)", () => {
    it("has exactly the 9 states (UX-19), each with label + description + a known tone", () => {
        expect(CONNECTION_STATES).toHaveLength(9);
        expect(Object.keys(CONNECTION_STATE_LABELS).sort()).toEqual([...CONNECTION_STATES].sort());
        for (const s of CONNECTION_STATES) {
            const l = CONNECTION_STATE_LABELS[s];
            expect(l.label.length).toBeGreaterThan(2);
            expect(l.description.length).toBeGreaterThan(20);
            expect(TONES).toContain<Tone>(l.tone);
        }
    });
    it("prototype vocabulary kept verbatim", () => {
        expect(CONNECTION_STATES.map((s) => CONNECTION_STATE_LABELS[s].label)).toEqual([
            "Not configured", "Testing…", "Connected", "Syncing…", "Partial sync", "Invalid credentials", "Insufficient permission", "Unreachable", "Incompatible API",
        ]);
    });
    it("every W05 error class has alert copy (title + body)", () => {
        expect(Object.keys(CONNECTION_ERROR_COPY).sort()).toEqual([...ARCANE_ERROR_CLASSES].sort());
        for (const c of ARCANE_ERROR_CLASSES) expect(CONNECTION_ERROR_COPY[c].title && CONNECTION_ERROR_COPY[c].body).toBeTruthy();
        expect(Object.keys(HEALTH_FOR_CLASS)).toHaveLength(ARCANE_ERROR_CLASSES.length);
    });
    it("copy never calls the Arcane key 'read-only' and never leaks URLs/headers wording", () => {
        const all = JSON.stringify([CONNECTION_STATE_LABELS, CONNECTION_ERROR_COPY, REFUSAL_COPY]).toLowerCase();
        for (const w of ARCANE_KEY_FIELD_COPY.forbiddenWords) expect(all).not.toContain(w);
        expect(all).not.toMatch(/https?:\/\//);
        expect(all).not.toContain("x-api-key");
    });
    it("host roles match the DB enum exactly (production default, no runner before R3)", () => {
        expect(Object.keys(HOST_ROLE_LABELS).sort()).toEqual([...HOST_ROLES].sort());
        expect(HOST_ROLES[0]).toBe("production");
    });
    it("every action refusal code has copy", () => {
        for (const c of ["forbidden", "not_found", "locked", "rate_limited", "invalid_input", "key_reentry_required", "refused", "single_tenant_required"]) expect(REFUSAL_COPY[c]).toBeTruthy();
    });
});
