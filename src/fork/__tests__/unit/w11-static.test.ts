import {readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {ActivateInputSchema} from "@/fork/stack-policy/input";
import {PreviewInputSchema} from "@/fork/stack-policy/preview-service";

/** Structural guards of W11: copy-and-own boundary, no secret in client state/URLs/logs, server-side authority, no stop/quiesce, copy in labels.ts. */
const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? (f === "__tests__" ? [] : walk(p)) : /\.tsx?$/.test(f) ? [p] : [];
});
const read = (f: string) => readFileSync(f, "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const POLICY = walk(path.join(ROOT, "src/fork/stack-policy"));
const SCHEDULE = walk(path.join(ROOT, "src/fork/schedule"));
const WIZARD = walk(path.join(ROOT, "src/fork/ui/stacks/wizard"));
const COPIES = ["secret-input.tsx", "schedule-picker.tsx", "storage-channel-select.tsx"].map((f) => path.join(ROOT, "src/fork/ui", f));
const ACTION = path.join(ROOT, "src/fork/actions/stack-policy.action.ts");
const PAGE = path.join(ROOT, "app/(customer)/dashboard/(organization)/stacks/[stackId]/configure/page.tsx");
const UPSTREAM_IMPORT = /from\s+["']@\/(db\/schema\/(0\d|1\d)_|features\/|lib\/(safe-actions|auth|acl)|utils\/status-crypto|db["'/]|components\/ui\/sidebar)/;

describe("W11 structure", () => {
    it("finds the files", () => {
        expect(POLICY.map((f) => path.basename(f)).sort()).toEqual(["activate.ts", "channels.ts", "configure-view.ts", "input.ts", "policy-schema.ts", "policy-view.ts", "preview-service.ts", "preview.ts", "size-estimate.ts", "validate-selection.ts"]);
        expect(SCHEDULE.map((f) => path.basename(f)).sort()).toEqual(["cron-expr.ts", "schedule.ts"]);
        expect(WIZARD.map((f) => path.basename(f)).sort()).toEqual(["configure-form.client.tsx", "consistency-section.tsx", "model.ts", "outcome.ts", "resources-section.tsx", "review-section.tsx"]);
    });

    it("D31 boundary: stack-policy, schedule and the UI reach upstream only through src/fork/upstream (no upstream table/feature import)", () => {
        for (const f of [...POLICY, ...SCHEDULE, ...WIZARD, ...COPIES]) expect(code(f), f).not.toMatch(UPSTREAM_IMPORT);
        expect([...code(PAGE).matchAll(/from\s+["'](@\/(?!fork\/)[^"']+|next[^"']*)["']/g)].map((m) => m[1]).sort()).toEqual(["@/features/layout/components/page", "next", "next/navigation"]); // layout shell only, like W08
        // the action wrapper is the one place that may use upstream's `userAction` (session-bound entry point), nothing else
        expect(code(ACTION).match(/from\s+["']@\/(?!fork\/)[^"']+["']/g)).toEqual(['from "@/lib/safe-actions/actions"']);
    });

    it("the schedule and retention modules are pure: no db, no react, no fs/network, no process access", () => {
        for (const f of [...SCHEDULE, path.join(ROOT, "src/fork/recovery/retention-policy.ts")]) expect(code(f), f).not.toMatch(/@\/fork\/db|drizzle|from "react"|node:|\bfetch\(|process\.|child_process/);
    });

    it("`container_name` is never produced and no stop/quiesce field exists in the policy input or the UI (D29, R1)", () => {
        for (const f of [...POLICY, ...WIZARD, ...COPIES]) expect(code(f), f).not.toMatch(/container_name|containerName|quiesce|stop_copy|stopCopy/i);
        expect(Object.keys(ActivateInputSchema.shape).sort()).toEqual(["acceptedExclusions", "confirmDockerAccess", "retention", "schedule", "secrets", "selection", "stackId", "storageChannelIds"]);
        expect(ActivateInputSchema.safeParse({stackId: "0b7e1c1e-7f3a-4b6e-9a40-222222222222", stopContainers: true}).success).toBe(false);
    });

    it("secrets: the password never enters React state, URLs, storage, console or the preview; it exists only as `secrets` of the activate input", () => {
        const all = [...WIZARD, ...COPIES].map((f) => ({f, c: code(f)}));
        for (const {f, c} of all) expect(c, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|dangerouslySetInnerHTML|\bfetch\(|EventSource|WebSocket|searchParams|router\.(push|replace)/);
        const form = code(WIZARD.find((f) => f.endsWith("configure-form.client.tsx"))!);
        expect(form).not.toMatch(/useState[^;]*(secret|password)/i);
        expect(form).toContain("h?.take()");
        expect(form).toContain("clearPasswords");
        const secret = code(path.join(ROOT, "src/fork/ui/secret-input.tsx"));
        expect(secret).toContain('defaultValue=""');
        expect(secret).not.toMatch(/\bvalue=\{/);
        expect(PreviewInputSchema.safeParse({stackId: "0b7e1c1e-7f3a-4b6e-9a40-222222222222", secrets: {db: "x"}}).success).toBe(false);
        expect(code(path.join(ROOT, "src/fork/stack-policy/preview-service.ts"))).not.toMatch(/secrets|password/i);
    });

    it("no hard-coded colours, no title=/tooltips in the new UI; copy comes from labels.ts (no sentence-length literal in components)", () => {
        for (const f of [...WIZARD, ...COPIES, path.join(ROOT, "src/fork/ui/stacks/schedule-tab.tsx"), PAGE]) {
            const c = code(f);
            expect(c, f).not.toMatch(/#[0-9a-fA-F]{6}\b|\brgb\(|\bhsl\(|\boklch\(/);
            expect(c, f).not.toMatch(/<(?:div|span|a|button|section|li|p|abbr|td|th|input|select)\b[^>]*\btitle=|Tooltip|data-tooltip|onMouseEnter/);
            const src = c.replace(/(className|data-testid|aria-[a-z]+|id|key|scope|type|variant|size|tone|name|placeholder|data-[a-z]+|htmlFor|inputMode|autoComplete)=("[^"]*"|\{[^}]*\})/g, "");
            expect([...src.matchAll(/\{\s*"([^"{}<>\n]{25,})"\s*\}|:\s*"([^"{}<>\n]{25,})"|\?\s*"([^"{}<>\n]{25,})"/g)].map((m) => m[1] ?? m[2] ?? m[3]), f).toEqual([]);
            expect([...src.matchAll(/>\s*([A-Za-z][^<>{}\n]{24,})\s*</g)].map((m) => m[1]), f).toEqual([]);
        }
    });

    it("client modules export only components (a server page must not call a helper exported from a \"use client\" file)", () => {
        for (const f of [...WIZARD, ...COPIES].filter((x) => read(x).trimStart().startsWith('"use client"'))) {
            const lower = [...read(f).matchAll(/export (?:const|function|async function) ([a-z][A-Za-z0-9_]*)/g)].map((m) => m[1]).filter((n) => n !== "timezones");
            expect(lower, `${path.basename(f)} exports helpers from a client module`).toEqual([]);
        }
    });
});

describe("W11 server authority", () => {
    it("activation runs in a fixed order: input → authorize (capability, D21, rate) → D39 → channels (§4.5) → selection (SEC-24) → materialize (D31 ACL) → activate tx", () => {
        const c = code(path.join(ROOT, "src/fork/stack-policy/activate.ts"));
        const order = ["ActivateInputSchema.safeParse", "authorizeMutation(", "assertEncryptionForActivation(", "listAvailableChannels(", "checkChannelRule(", "validateSelection(", "materializeStack(", "withForkLock("].map((s) => c.indexOf(s));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
    it("the action is a thin wrapper: userAction, z.unknown() input, no logging; the page gates mode → principal → authorisation → loader", () => {
        const a = code(ACTION);
        expect(a).toContain("userAction.inputSchema(z.unknown())");
        expect(a).not.toMatch(/console\.|logger/);
        expect([...a.matchAll(/export const (\w+)/g)].map((m) => m[1]).sort()).toEqual(["activateStackPolicyAction", "previewStackPolicyAction"]);
        const p = code(PAGE);
        const order = ["currentForkMode()", "getForkPrincipal()", "assertForkResource(", "loadConfigureView("].map((s) => p.indexOf(s));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(read(PAGE)).toContain('export const dynamic = "force-dynamic"');
    });
    it("no API route was added (CSRF = Next's server-action origin check) and audit codes are namespaced fork.stack_policy.*", () => {
        expect(readdirSync(path.join(ROOT, "app"), {recursive: true}).filter((f) => String(f).includes("configure") && String(f).endsWith("route.ts"))).toEqual([]);
        expect([...code(path.join(ROOT, "src/fork/stack-policy/activate.ts")).matchAll(/"(fork\.[a-z_.]+)"/g)].map((m) => m[1]).filter((c) => c.startsWith("fork.stack_policy.") || c.startsWith("fork.materialize.")).length).toBeGreaterThanOrEqual(1);
    });
    it("the configure DTO never selects storage-channel configuration", () => {
        expect(code(path.join(ROOT, "src/fork/upstream/channels.ts"))).not.toMatch(/c\.config|select\s+\*|\bconfig\b/);
    });
});
