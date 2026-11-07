import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import {FORK_MIN_AGENT_FOR_STACKS} from "@/fork/versions";

/**
 * D31 contract tests (W-SYNC step 4). The fork has no `src/fork/upstream/` copies yet (first one lands in W10), so this
 * pins the upstream SURFACES fork code imports or reads today. After every upstream sync a failure here means the fork
 * must be adapted in the same sync PR (re-copy / re-hook) — never merged red. Source-text checks on purpose: they run
 * in the unit tier without a DB and name the exact upstream symbol that moved.
 */
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const exportsOf = (src: string) => [
    ...[...src.matchAll(/export\s+(?:const|function|async function|type|interface)\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]),
    // `export { A, B as C }` lists (shadcn-style files)
    ...[...src.matchAll(/export\s*\{([^}]*)\}/g)].flatMap((m) => m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop() ?? "").filter(Boolean)),
];

describe("upstream contract — symbols the fork imports", () => {
    it.each([
        ["src/lib/auth/current-user.ts", "currentUser"],
        ["src/lib/logger.ts", "logger"],
        // W05: server actions are built on the upstream safe-action client (signed-in, not pending/banned)
        ["src/lib/safe-actions/actions.ts", "userAction"],
        // W15: the agent-channel actions need the dashboard base URL (PROJECT_URL) the agents will call
        ["src/utils/get-server-url.ts", "getServerUrl"],
        ["src/features/layout/components/menu-sidebar.tsx", "SidebarMenuCustomBase"],
        ["src/features/layout/components/menu-sidebar.tsx", "SidebarGroupItem"],
        ["src/components/ui/sidebar.tsx", "SidebarProvider"],
        // W04: upstream tables the fork schema references (D32 FK targets) and reads (self-check)
        ["src/db/schema/03_organization.ts", "organization"],
        ["src/db/schema/04_member.ts", "member"],
        ["src/db/schema/06_project.ts", "project"],
        ["src/db/schema/07_database.ts", "backup"],
        // W10: the copy-and-own adapter `src/fork/upstream/` (own pins: w10-upstream-contract.test.ts)
        ["src/db/schema/07_database.ts", "database"],
        ["src/db/schema/07_database.ts", "retentionPolicy"],
        ["src/db/schema/13_storage-policy.ts", "storagePolicy"],
        ["src/db/schema/10_alert-policy.ts", "alertPolicy"],
        ["src/db/schema/01_setting.ts", "setting"],
        ["src/utils/status-crypto.ts", "isAgentVersionAtLeast"],
        ["src/db/schema/08_agent.ts", "agent"],
        ["src/db/schema/08_agent.ts", "organizationAgent"],
        ["src/db/schema/12_storage-channel.ts", "storageChannel"],
        ["src/db/schema/12_storage-channel.ts", "organizationStorageChannel"],
        ["src/db/schema/14_storage-backup.ts", "backupStorage"],
        // W12: stack runs read/queue/delete upstream backups through `src/fork/upstream/backups.ts` (own pins: w12-runs-upstream-contract.test.ts)
        ["src/db/schema/07_database.ts", "restoration"],
        ["src/lib/tasks/database/utils/backup-delete.service.ts", "deleteBackupService"],
        ["src/features/database/services/backup-download.service.ts", "getBackupDownloadUrlService"],
        ["src/db/schema/02_user.ts", "user"], // run-time re-authorization reads the activating user's CURRENT role / banned flag
        ["src/db/index.ts", "db"],
        // W06: Integrations UI reuses the upstream design-system primitives (Radix/shadcn) and the agent-status util
        ["src/components/ui/alert-dialog.tsx", "AlertDialog"],
        ["src/components/ui/alert.tsx", "Alert"],
        ["src/components/ui/button.tsx", "Button"],
        ["src/components/ui/dialog.tsx", "Dialog"],
        ["src/components/ui/input.tsx", "Input"],
        ["src/components/ui/label.tsx", "Label"],
        ["src/components/ui/select.tsx", "Select"],
        ["src/components/ui/switch.tsx", "Switch"],
        ["src/components/ui/table.tsx", "Table"],
        ["src/components/ui/tabs.tsx", "Tabs"], // W08
        ["src/components/ui/checkbox.tsx", "Checkbox"], // W11 (controlled copies of the storage selector / forms)
        ["src/components/ui/radio-group.tsx", "RadioGroup"],
        ["src/components/ui/radio-group.tsx", "RadioGroupItem"],
        ["src/lib/utils.ts", "cn"],
        ["src/features/agents/utils/status/agent-status.ts", "getAgentStatus"],
        ["src/features/agents/utils/status/agent-status.ts", "DASHBOARD_THRESHOLDS"],
    ])("%s still exports %s", (file, symbol) => {
        expect(exportsOf(read(file))).toContain(symbol);
    });

    it("every non-fork import in src/fork (non-test) is covered by the table above", () => {
        const covered = new Set([
            "@/lib/auth/current-user", "@/lib/logger", "@/lib/safe-actions/actions", "@/utils/get-server-url", "@/features/layout/components/menu-sidebar", "@/components/ui/sidebar",
            "@/db/schema/03_organization", "@/db/schema/04_member", "@/db/schema/06_project", "@/db/schema/07_database",
            "@/db/schema/08_agent", "@/db/schema/14_storage-backup",
            // W10 (src/fork/upstream only — w10-static.test.ts enforces that boundary)
            "@/db/schema/13_storage-policy", "@/db/schema/10_alert-policy", "@/db/schema/01_setting", "@/utils/status-crypto",
            // W12 (src/fork/upstream only): activating user (re-authorization)
            "@/db/schema/02_user",
            // W13 (src/fork/upstream only): the upstream notification dispatcher (lazy import in the job)
            "@/features/notifications/utils/notifications.dispatch",
            // W06
            "@/components/ui/alert-dialog", "@/components/ui/alert", "@/components/ui/button", "@/components/ui/dialog", "@/components/ui/input", "@/components/ui/label",
            "@/components/ui/select", "@/components/ui/switch", "@/components/ui/table", "@/components/ui/tabs", "@/lib/utils", "@/components/ui/checkbox", "@/components/ui/radio-group", "@/features/agents/utils/status/agent-status",
        ]);
        const walk = (dir: string): string[] =>
            readdirSync(dir, {withFileTypes: true}).flatMap((e) =>
                e.name === "__tests__" ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []);
        const imports = new Set<string>();
        for (const f of walk(path.join(process.cwd(), "src/fork")))
            for (const m of readFileSync(f, "utf8").matchAll(/from\s+["'](@\/[^"']+)["']/g)) if (!m[1].startsWith("@/fork/")) imports.add(m[1]);
        expect([...imports].filter((i) => !covered.has(i))).toEqual([]);
    });
});

describe("upstream contract — agent protocol gates the fork reads (never edits, P13)", () => {
    it("status-crypto.ts still defines the MIN_AGENT_VERSION_* gates", () => {
        const src = read("src/utils/status-crypto.ts");
        for (const n of ["MIN_AGENT_VERSION_STORAGE_ENC", "MIN_AGENT_VERSION_DB_CONFIG", "MIN_AGENT_VERSION_SIGNED_REQUESTS"]) expect(src).toMatch(new RegExp(`export const ${n}\\s*=`));
    });
    it("FORK_MIN_AGENT_FOR_STACKS equals upstream's signed-requests gate (files/restic need >= 1.24.0)", () => {
        const m = read("src/utils/status-crypto.ts").match(/MIN_AGENT_VERSION_SIGNED_REQUESTS\s*=\s*"([^"]+)"/);
        expect(m?.[1]).toBe(FORK_MIN_AGENT_FOR_STACKS);
    });
    it("features/agents/utils/version.ts still defines the files/restic/db-config gates", () => {
        const src = read("src/features/agents/utils/version.ts");
        for (const n of ["MIN_DATABASE_CONFIG_AGENT_VERSION", "MIN_FILES_AGENT_VERSION", "MIN_RESTIC_AGENT_VERSION"]) expect(src).toMatch(new RegExp(`${n}\\s*=`));
    });
});

describe("upstream contract — migration lane assumptions (ADR-003)", () => {
    it("upstream journal keeps {entries:[{when}]} and drizzle's migrations table name", () => {
        const j = JSON.parse(read("src/db/migrations/meta/_journal.json"));
        expect(Array.isArray(j.entries)).toBe(true);
        expect(j.entries.length).toBeGreaterThan(0);
        for (const e of j.entries) expect(typeof e.when).toBe("number");
        expect(read("src/fork/db/migrate.ts")).toContain("__drizzle_migrations");
    });
    it("upstream init() still runs makeMigration() before the fork hook (P02 order: upstream lane first)", () => {
        const src = read("src/utils/init/index.ts");
        const up = src.indexOf("await makeMigration()");
        const fk = src.indexOf("await initFork()");
        expect(up).toBeGreaterThan(-1);
        expect(fk).toBeGreaterThan(up);
    });
    it("upstream src/db/index.ts still exposes the `schemas` object the P01 spread lives in", () => {
        expect(read("src/db/index.ts")).toMatch(/const schemas\s*=\s*\{/);
    });
});

describe("upstream contract — routing/proxy hooks (P04)", () => {
    it("proxy.ts still has routePatterns + checkRouteExists + a /dashboard branch the gate attaches to", () => {
        const src = read("proxy.ts");
        expect(src).toMatch(/routePatterns/);
        expect(src).toMatch(/checkRouteExists/);
        expect(src).toMatch(/\/dashboard/);
    });
});
