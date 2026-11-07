import {describe, expect, it} from "vitest";
import {CONSISTENCY_FACETS, DELETABLE_VALUES, DIRECTIVE_CODES, ITEM_KINDS, ITEM_STATUSES, PRIMARY_STATES, REASON_CODES} from "@/fork/completeness/types";
import {RP_STATUSES} from "@/fork/recovery/status";
import {DIRECTIVE_COPY, FACET_COPY, ITEM_KIND_LABELS, ITEM_STATUS_LABELS, PRIMARY_STATE_LABELS, REASON_COPY, RP_STATUS_LABELS} from "@/fork/ui/labels";
import {TONES} from "@/fork/ui/tone";

/** Every member of every closed vocabulary has copy in labels.ts (UX-11), is a sentence, and uses a tone from the one tone map. */
describe("W09 labels cover every state, reason, facet value", () => {
    it("primary states (7, in §4.6 order) have label + description + tone", () => {
        expect(Object.keys(PRIMARY_STATE_LABELS)).toEqual([...PRIMARY_STATES].sort((a, b) => Object.keys(PRIMARY_STATE_LABELS).indexOf(a) - Object.keys(PRIMARY_STATE_LABELS).indexOf(b)));
        for (const k of PRIMARY_STATES) {
            const l = PRIMARY_STATE_LABELS[k];
            expect(l.label.length, k).toBeGreaterThan(3);
            expect(l.description, k).toMatch(/\.$/);
            expect(TONES).toContain(l.tone);
        }
    });
    it("only the Protected state may use the success tone or the word 'Protected' as its own label", () => {
        for (const k of PRIMARY_STATES) {
            if (k !== "protected") { expect(PRIMARY_STATE_LABELS[k].tone, k).not.toBe("success"); expect(PRIMARY_STATE_LABELS[k].label, k).not.toMatch(/^Protected$/); }
        }
        expect(PRIMARY_STATE_LABELS.unprotected.label).toBe("Unprotected");
    });
    it("item statuses, kinds, reasons, directives", () => {
        for (const s of ITEM_STATUSES) { expect(ITEM_STATUS_LABELS[s].label, s).toBeTruthy(); expect(TONES).toContain(ITEM_STATUS_LABELS[s].tone); }
        for (const k of ITEM_KINDS) expect(ITEM_KIND_LABELS[k], k).toBeTruthy();
        for (const r of REASON_CODES) expect(REASON_COPY[r], r).toMatch(/\.$/);
        for (const d of DIRECTIVE_CODES) expect(DIRECTIVE_COPY[d], d).toMatch(/\.$/);
        expect(Object.keys(REASON_COPY).sort()).toEqual([...REASON_CODES].sort());
    });
    it("RP statuses: every D43 status has copy; pending reads 'Backed up · verifying' and is never success", () => {
        for (const s of RP_STATUSES) expect(RP_STATUS_LABELS[s].label, s).toBeTruthy();
        expect(RP_STATUS_LABELS.pending_verification.label).toBe("Backed up · verifying");
        expect(RP_STATUS_LABELS.pending_verification.tone).not.toBe("success");
        expect(RP_STATUS_LABELS.verified.tone).toBe("success");
    });
    it("facets: deletable + consistency values, all seven facet headings and the locked facet exist", () => {
        for (const d of DELETABLE_VALUES) { expect(FACET_COPY.deletable.values[d]).toBeTruthy(); expect(FACET_COPY.deletable.description[d]).toMatch(/\.$/); }
        for (const c of CONSISTENCY_FACETS) expect(FACET_COPY.consistency.values[c]).toBeTruthy();
        expect(FACET_COPY.consistency.values).toEqual({database_saved_safely: "Database saved safely", files_copied_running: "Files copied while running", app_paused: "App paused during copy"});
        for (const k of ["lastGood", "testRestore", "deletable", "hostCompromise", "consistency", "paused", "inventoryStale", "configLocked"] as const) expect(FACET_COPY[k].label, k).toBeTruthy();
        expect(FACET_COPY.configLocked.label).toBe("Fork configuration locked");
        expect(FACET_COPY.hostCompromise.label).toBe("Not protected against host compromise");
    });
    it("honest copy: no label implies a guarantee outside the Protected/Verified states", () => {
        const guarantee = /\b(guarantee|fully protected|all good|healthy)\b/i;
        for (const t of [...Object.values(REASON_COPY), ...Object.values(ITEM_STATUS_LABELS).map((x) => x.description)]) expect(t).not.toMatch(guarantee);
        expect(PRIMARY_STATE_LABELS.partial.description).toContain("Full-stack recovery is not available until the gaps below are resolved");
    });
});
