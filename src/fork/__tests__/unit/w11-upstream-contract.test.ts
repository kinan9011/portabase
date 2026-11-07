import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {isValidCronPart as upstreamIsValidCronPart} from "@/utils/cron";
import {CRON_FIELDS, isValidCron, isValidCronPart} from "@/fork/schedule/cron-expr";

/**
 * D31 CONTRACT TESTS for the controlled UI/logic copies of W11 — run on EVERY W-SYNC (03-Upstream-Sync-Runbook). A failure after an upstream
 * merge means: re-diff the upstream file against our copy (named on the right), adapt `src/fork/ui/**` / `src/fork/schedule/**` in the SAME sync
 * PR, then update the pinned hash. Never merge red, never silence by deleting a pin.
 */
const root = process.cwd();
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(root, p))).digest("hex");

describe("pinned upstream sources the W11 copies derive from (as of the fork base v1.35.2)", () => {
    const PINS: [string, string, string][] = [
        ["src/utils/cron.ts", "a1177afc4f8cb21074a740148f8b269cc930971ee9102d3092db08a4a4946ef4", "schedule/cron-expr.ts (isValidCronPart copy)"],
        ["src/features/onboarding/components/backup-schedule-selector.tsx", "ff41ef818ac1051a2fc6d6e76b9451a8f2ce0775b7c5fc99fcb3c59a9415ec99", "ui/schedule-picker.tsx (presets + custom cron)"],
        ["src/features/database/components/cron-advanced-select.tsx", "4e77ee4a6c6b885f4e476ea58128b46d02283330b873eda499f7975443ce83ed", "ui/schedule-picker.tsx (advanced cron disclosure)"],
        ["src/features/database/components/channels-policy-form.tsx", "87522a5e8281fcdbdffe9f61b2755d270923273610bec8436381066c93f41baf", "ui/storage-channel-select.tsx (channel picker)"],
        ["src/features/database/components/channels-policy-modal.tsx", "a0b954403a04e907b5444336dbba48d7f1c633c1c2ef05eedadc91ef04845a54", "ui/storage-channel-select.tsx (channel picker)"],
        ["src/features/database/components/retention-policy-form.tsx", "a09622a98d191d926dd24ffb5c642570962f579340d18a8b9546af6d101ce868", "recovery/retention-policy.ts (upstream is PER-SOURCE retention; the fork's is GFS over recovery points, D33: re-read to keep the vocabulary aligned)"],
        ["src/components/ui/checkbox.tsx", "4c395ef15549e46068eb3b32a2a10fb5bfdb01f6834a3c0231a218a529015c83", "storage-channel-select + wizard (Radix Checkbox)"],
        ["src/components/ui/radio-group.tsx", "b12ca5cef859dd75b274337234bae66e413b0f97845243254a1dedcb2d7a7237", "wizard consistency section (Radix RadioGroup)"],
        ["src/components/ui/input.tsx", "614b9960c7bcec9fda0e9164678c4b9b9301009db388f5f803f7a0820f9d662d", "wizard + secret-input"],
    ];
    it.each(PINS)("%s unchanged (copy: %s)", (file, hash) => { expect(sha(file)).toBe(hash); });
});

describe("cron validator: our copy agrees with upstream's on a corpus", () => {
    const CORPUS: Record<(typeof CRON_FIELDS)[number], string[]> = {
        minute: ["*", "0", "59", "60", "-1", "*/5", "*/0", "*/60", "1-5", "5-1", "1,2,3", "1,,2", "", " ", "a", "1-60", "10/5", "*/x", "0-59/10", "07"],
        hour: ["*", "0", "23", "24", "*/6", "*/12", "*/24", "1-23", "0,12", "x"],
        "day-of-month": ["*", "0", "1", "31", "32", "1-15", "*/2", "L"],
        month: ["*", "0", "1", "12", "13", "1-12", "*/3", "jan"],
        "day-of-week": ["*", "0", "6", "7", "1-5", "*/2", "mon"],
    };
    for (const [type, values] of Object.entries(CORPUS)) {
        it(`${type}: same verdict for every value`, () => {
            for (const v of values) expect(isValidCronPart(type, v), `${type}=${JSON.stringify(v)}`).toBe(upstreamIsValidCronPart(type, v));
        });
    }
    it("a five-field expression is valid exactly when every field is (and length is bounded)", () => {
        expect(isValidCron("0 2 * * 1-5")).toBe(true);
        expect(isValidCron("0 2 * *")).toBe(false);
        expect(isValidCron("0 2 * * * *")).toBe(false);
        expect(isValidCron("99 2 * * *")).toBe(false);
        expect(isValidCron("* ".repeat(60))).toBe(false);
    });
});
