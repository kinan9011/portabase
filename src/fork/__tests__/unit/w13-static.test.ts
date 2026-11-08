import {readFileSync, readdirSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

/** Structural guards for W13 (tabs, strip, notifications, schedule edit). Comments may mention the words these checks forbid, so comment lines are stripped. */
const ROOT = path.resolve(__dirname, "../../..");
const walk = (d: string): string[] => readdirSync(d, {withFileTypes: true}).flatMap((e) => (e.isDirectory() ? (e.name === "__tests__" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])).filter((f) => /\.tsx?$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => read(f).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const NOTIFY = walk(path.join(ROOT, "fork/notifications"));
const UI = ["backups", "activity", "schedule", "safety-strip"].flatMap((d) => walk(path.join(ROOT, "fork/ui/stacks", d)));
const VIEWS = ["backups-view.ts", "activity-view.ts", "safety.ts", "safety-queries.ts", "protection-load.ts"].map((f) => path.join(ROOT, "fork/stacks", f));
const NEW_SERVER = [...NOTIFY, ...VIEWS, path.join(ROOT, "fork/stack-policy/update-schedule.ts"), path.join(ROOT, "fork/actions/stack-schedule.action.ts")];

describe("W13 structure", () => {
    it("finds the files", () => {
        expect(NOTIFY.map((f) => path.basename(f)).sort()).toEqual(["conditions.ts", "deliver.ts", "evaluate.ts", "job.ts", "render.ts", "vocab.ts"]);
        expect(UI.map((f) => path.basename(f)).sort()).toEqual(["activity-tab.tsx", "backups-tab.tsx", "run-panel.tsx", "safety-strip.tsx", "schedule-edit.client.tsx", "schedule-tab.tsx", "stage-announcer.client.tsx"]);
    });

    it("polling only: no SSE / WebSocket / upstream event bus / fetch in any W13 file (UX-13, CH-32)", () => {
        for (const f of [...UI, ...NEW_SERVER]) expect(code(f), f).not.toMatch(/EventSource|text\/event-stream|WebSocket|@\/lib\/event|\bfetch\(|XMLHttpRequest|sendBeacon/);
    });

    it("no raw HTML injection, browser storage, cookies or console output", () => {
        for (const f of [...UI, ...NEW_SERVER]) expect(code(f), f).not.toMatch(/dangerouslySetInnerHTML|localStorage|sessionStorage|indexedDB|document\.cookie|console\.|\.innerHTML/);
    });

    it("D31 boundary: the notification module and the views reach upstream ONLY through src/fork/upstream (no upstream table/feature import)", () => {
        const UPSTREAM_IMPORT = /from\s+["']@\/(db\/schema\/(0\d|1\d)_|features\/|lib\/(safe-actions|auth|acl)|utils\/status-crypto|db["'/])/;
        for (const f of [...NOTIFY, ...VIEWS, path.join(ROOT, "fork/stack-policy/update-schedule.ts")]) expect(code(f), f).not.toMatch(UPSTREAM_IMPORT);
        // the ONE static path to the upstream dispatcher is the sender adapter, loaded lazily
        expect(code(path.join(ROOT, "fork/notifications/job.ts"))).toContain('await import("@/fork/upstream/notification-send")');
    });

    it("the read models are strict DTOs: z.strictObject only, never a loose z.object", () => {
        for (const f of [path.join(ROOT, "fork/stacks/backups-view.ts"), path.join(ROOT, "fork/stacks/activity-view.ts"), path.join(ROOT, "fork/stacks/safety.ts")]) {
            expect(code(f), f).toContain("z.strictObject");
            expect(code(f), f).not.toMatch(/z\.object\(|z\.looseObject\(/);
        }
        // the Backups DTO has no column that could carry a path, id of an upstream row, key or raw error
        const b = code(path.join(ROOT, "fork/stacks/backups-view.ts"));
        expect(b).not.toMatch(/pathOrSnapshotId|path_or_snapshot_id|backup_id|backupId|backupStorageId|generatedId|ciphertext_sha256:\s*z/);
    });

    it("the notification body renderer interpolates only closed-table lookups, the sanitised name, a validated uuid and a clamped hour count", () => {
        const r = code(path.join(ROOT, "fork/notifications/render.ts"));
        const payloadReads = [...r.matchAll(/payload\.(\w+)/g)].map((m) => m[1]).sort();
        expect([...new Set(payloadReads)]).toEqual(["hours", "reason", "since", "stackId", "state"]); // W17b adds state + since (closed-table / fixed-format use only)
        expect(r).not.toMatch(/JSON\.stringify|\.message\b.*payload|payload\.(error|path|link|url|key|name)/);
    });

    it("notifications run on the RUNTIME plane (they keep flowing while configuration is locked, ADR-010) and register from fork init, not an upstream file", () => {
        const j = code(path.join(ROOT, "fork/notifications/job.ts"));
        expect(j).toMatch(/plane:\s*"runtime"/);
        expect(j).not.toMatch(/plane:\s*"config"/);
        expect(code(path.join(ROOT, "fork/init.ts"))).toContain("registerNotificationsJob()");
        // a locked fork must not stop delivery: the job returns early ONLY for mode `off`
        expect(j).toMatch(/mode\.mode === "off"\) return/);
        expect(j).not.toMatch(/mode\.mode === "locked"\) return/);
    });

    it("the schedule edit is a configuration mutation: authorised, gated by the D21 lock and audited through the shared service helpers", () => {
        const u = code(path.join(ROOT, "fork/stack-policy/update-schedule.ts"));
        expect(u).toContain("authorizeMutation(d, \"fork.stack_policy.edit_schedule\"");
        expect(u).toContain("recordAudit");
        expect(u).not.toMatch(/pausedAt:\s*null|pauseReason:\s*null/); // only a full re-activation clears a pause (F7)
        const a = code(path.join(ROOT, "fork/actions/stack-schedule.action.ts"));
        expect(a).toContain("updateStackSchedule(await deps(), parsedInput)");
    });

    it("honest copy: no W13 UI file spells a status word itself — labels come from ui/labels.ts", () => {
        for (const f of UI.filter((x) => !/run-panel|schedule-tab/.test(x))) expect(code(f), f).not.toMatch(/["'`>]\s*(Protected|Verified|Safe)\b/);
    });
});
