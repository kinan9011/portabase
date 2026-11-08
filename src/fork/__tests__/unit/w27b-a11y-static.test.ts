import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {KIT} from "@/fork/ui/labels";
import {AGENT_CHANNEL} from "@/fork/ui/agent-channel/labels";

// W27b static guards (plan-W27b §5.1): they fail when a fixed WCAG defect comes back.
const ROOT = path.resolve(__dirname, "../../../..");
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const APP = path.join(ROOT, "app/(customer)/dashboard");
const UI = walk(path.join(ROOT, "src/fork/ui")).filter((f) => /\.(ts|tsx)$/.test(f));
const ROUTES = [
    ...walk(path.join(APP, "(organization)/stacks")), ...walk(path.join(APP, "(organization)/recovery")),
    ...walk(path.join(APP, "(admin)/integrations/agent-channel")), ...walk(path.join(APP, "(admin)/integrations/recovery-kit")),
].filter((f) => /\.(ts|tsx)$/.test(f));
const SCOPE = [...UI, ...ROUTES];
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => path.relative(ROOT, f);

describe("W27b static guards", () => {
    it("scope is not empty", () => {
        expect(UI.length).toBeGreaterThan(60);
        expect(ROUTES.some((f) => f.endsWith("recovery-kit/page.tsx"))).toBe(true);
    });

    it("DD-W27b-9: no Arabic code point in fork UI or fork routes (add `lang`/`dir` together with the first Arabic string)", () => {
        const hits = SCOPE.filter((f) => /[؀-ۿ]/.test(read(f))).map(rel);
        expect(hits).toEqual([]);
    });

    it("every spinning/pulsing animation is switched off by prefers-reduced-motion", () => {
        const bad: string[] = [];
        for (const f of SCOPE) for (const m of read(f).matchAll(/"[^"\n]*\banimate-(?:spin|pulse|ping|bounce)\b[^"\n]*"|`[^`\n]*\banimate-(?:spin|pulse|ping|bounce)\b[^`\n]*`/g)) if (!m[0].includes("motion-reduce:animate-none")) bad.push(`${rel(f)}: ${m[0].slice(0, 60)}`);
        expect(bad).toEqual([]);
    });

    it("D-02: no conditionally mounted role=status beside the stack page's shared announcer", () => {
        const dirs = ["run-controls.client.tsx", "schedule/", "test-restore/", "quiesce/"].map((d) => path.join(ROOT, "src/fork/ui/stacks", d));
        const files = UI.filter((f) => dirs.some((d) => f.startsWith(d)));
        expect(files.length).toBeGreaterThanOrEqual(8);
        const bad = files.filter((f) => /&&\s*\(?\s*<\w+[^>]*role="status"/.test(read(f))).map(rel);
        expect(bad).toEqual([]);
    });

    it("D-01: fork-rendered primary actions never use the upstream --primary pair", () => {
        const bad = SCOPE.filter((f) => /bg-primary text-primary-foreground/.test(read(f))).map(rel);
        expect(bad).toEqual([]);
    });

    it("D-01: the default-variant Buttons listed in the plan carry the AA colour (className-only)", () => {
        const files = ["agent-channel/agent-channel-panel.client.tsx", "integrations/connection-card.tsx", "integrations/connection-form.tsx", "kit/kit-extras.client.tsx", "kit/kit-panel.client.tsx",
            "stacks/config/restore-overrides-panel.client.tsx", "stacks/quiesce/quiesce-panel.client.tsx", "stacks/schedule/schedule-edit.client.tsx"].map((f) => path.join(ROOT, "src/fork/ui", f));
        const bad: string[] = [];
        for (const f of files) for (const [i, line] of read(f).split("\n").entries()) {
            if (!/<(Button|ReasonButton)\b/.test(line) || /variant=|sr-only/.test(line) || line.includes("KEK_ROTATION.button")) continue;
            if (!/PRIMARY_AA|bg-\[#c2410c\]/.test(line)) bad.push(`${rel(f)}:${i + 1}`);
        }
        expect(bad).toEqual([]);
    });

    it("D-06: only account-password fields declare a purpose; the passphrases and the DB password keep the suppressed attributes", () => {
        const withPurpose = SCOPE.flatMap((f) => read(f).split("\n").filter((l) => /<SecretInput\b[^>]*purpose=/.test(l)).map((l) => `${rel(f)}: ${(/name=("[^"]+"|\{`[^`]+`\})/.exec(l) ?? [])[1]}`));
        expect(withPurpose.sort()).toEqual([
            "src/fork/ui/agent-channel/agent-channel-panel.client.tsx: {`pw-${a.id}`}", "src/fork/ui/kit/kit-extras.client.tsx: \"kek-password\"", "src/fork/ui/kit/kit-panel.client.tsx: \"kit-password\"",
        ].sort());
    });

    it("D-07: the agent-channel and recovery-kit pages are titled", () => {
        const kit = read(path.join(APP, "(admin)/integrations/recovery-kit/page.tsx"));
        const ch = read(path.join(APP, "(admin)/integrations/agent-channel/page.tsx"));
        expect(kit).toContain("export const metadata: Metadata = {title: KIT.page.title};");
        expect(ch).toContain("export const metadata: Metadata = {title: AGENT_CHANNEL.page.title};");
        expect(KIT.page.title).toBe("Recovery kit");
        expect(AGENT_CHANNEL.page.title).toBe("Agent channel");
    });

    it("the W27b copy file is separate from the shared labels file", () => {
        expect(existsSync(path.join(ROOT, "src/fork/ui/a11y/labels.ts"))).toBe(true);
    });
});
