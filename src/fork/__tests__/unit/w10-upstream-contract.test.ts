import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {getTableColumns} from "drizzle-orm";
import {describe, expect, it} from "vitest";
import {agent} from "@/db/schema/08_agent";
import {setting} from "@/db/schema/01_setting";
import {project} from "@/db/schema/06_project";
import {database, retentionPolicy} from "@/db/schema/07_database";
import {storagePolicy} from "@/db/schema/13_storage-policy";
import {decryptSecret} from "@/features/database/utils/credential-crypto";
import {DB_SECRET_FIELDS} from "@/features/database/utils/credential-fields";
import {resolveBackupCron, resolveRetentionPolicy} from "@/features/database/utils/policy-resolution";
import {DatabaseConfigFormSchema, pruneAgentConfig} from "@/features/database/schemas/database-config.schema";
import {splitMethod} from "@/features/database/utils/backup-method";
import {SECRET_FIELDS, encryptSecret, stackProjectSlug, stripSecrets, withEncryptedSecrets} from "@/fork/upstream";
import {planStack} from "@/fork/materialize/plan";
import {SelectionSchema} from "@/fork/materialize/types";
import {cleanInventory} from "@/fork/__tests__/w09-fixtures";

/**
 * D31 CONTRACT TESTS for the controlled copies in `src/fork/upstream/` — run on EVERY W-SYNC (03-Upstream-Sync-Runbook).
 * A failure after an upstream merge means: re-diff the upstream file against our copy, adapt `src/fork/upstream/**` in the SAME sync
 * PR, then update the pinned hash. Never merge red, never silence by deleting a pin.
 */
const root = process.cwd();
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(root, p))).digest("hex");

describe("pinned upstream sources we copied (re-review on change)", () => {
    // sha256 of the upstream file as of the fork base v1.35.2 (W10). The copy that depends on each is named on the right.
    const PINS: [string, string, string][] = [
        ["src/features/database/actions/database-config.action.ts", "da0629b193dd9e5a8b034e4013c1be620e8418c5fd928118d80ae835b74fbd55", "upstream/sources.ts createMemberSource/updateMemberSource"],
        ["src/features/database/utils/credential-crypto.ts", "84b802c0d46bf42e7a2e3243c5e4740fc3acbb6a3f1575246eb1b571da63a508", "upstream/credentials.ts"],
        ["src/features/database/utils/credential-fields.ts", "fc5f42f09ac281cf886495dee9b6258633a7d7316d3a13b00d9cfc9c27ff5067", "upstream/credentials.ts SECRET_FIELDS"],
        ["src/features/database/utils/policy-resolution.ts", "359b471db989cf2b9b53d95aa759502a0946e439220402cf7b5d6180da26a633", "upstream/projects.ts readEffectivePolicy (D30 effective policy)"],
        ["src/features/database/services/database-delete.service.ts", "d370f829e69881454cb3db2655d2e5f4c086d4e0dac5030187c4c241c69d8065", "upstream/sources.ts removeMemberSource"],
        ["src/features/database/utils/database-acl.ts", "4d34bd7768770654cb57900b1b8fa89bd0834553b7a6735f4cdea95aa697ad4d", "upstream/agents.ts agentAclAllows"],
        ["src/features/projects/actions/projects.action.ts", "d01b38adc3c0d327d438a67a32246f293c9f66e7f5eb1f7a789da36f15a219f6", "upstream/projects.ts createStackProject"],
        ["src/features/database/schemas/database-config.schema.ts", "7b423cd360d6388c35ae734981527217563d5cbf62ba313e8935c16c232c0523", "materialize/types.ts DUMP_REQUIRED + config shapes"],
    ];
    it.each(PINS)("%s unchanged since the copy was made (%s)", (file, hash, copy) => {
        expect(sha(file), `upstream ${file} changed: re-diff ${copy}, adapt it, then update this pin`).toBe(hash);
    });
});

describe("credentials copy ↔ upstream", () => {
    const key = Buffer.alloc(32, 7);
    it("an envelope written by the copy decrypts with UPSTREAM decryptSecret (same on-disk format the agent path reads)", () => {
        const env = encryptSecret("s3cret-ünï", key);
        expect(decryptSecret(env as never, key)).toBe("s3cret-ünï");
        expect(env).toMatchObject({__encrypted: true, version: 1, kid: "credentials-v1"});
    });
    it("secret-field map equals upstream DB_SECRET_FIELDS", () => {
        expect(SECRET_FIELDS).toEqual(DB_SECRET_FIELDS);
    });
    it("withEncryptedSecrets never keeps a plaintext password; update without a secret keeps the previous envelope; stripSecrets removes it", () => {
        const created = withEncryptedSecrets("postgresql", {host: "h", port: 5432, username: "u", database: "d"}, {password: "pw"}, null, key);
        expect(JSON.stringify(created)).not.toContain("\"pw\"");
        expect(decryptSecret(created.password as never, key)).toBe("pw");
        const kept = withEncryptedSecrets("postgresql", {host: "h2"}, {}, created, key);
        expect(kept.password).toEqual(created.password);
        expect(stripSecrets("postgresql", created)).toEqual({host: "h", port: 5432, username: "u", database: "d"});
    });
});

describe("generated configs ↔ upstream config schema", () => {
    const inv = cleanInventory();
    inv.services.push({name: "db", state: "running", image: {ref: "postgres:16", pinned: false, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: [], database_hint: {engine: "postgresql", basis: "image"}});
    inv.services.push({name: "lite", state: "running", image: {ref: "x", pinned: false, built_locally: false}, ports: [], networks: [], mounts: [], env_keys: [], database_hint: {engine: "sqlite", basis: "mount"}});
    const plan = planStack(inv, SelectionSchema.parse({databases: {db: {kind: "dump", host: "demo-db", port: 5432, username: "u", database: "d"}, lite: {kind: "sqlite", path: "/lab/sqlite/app.db"}}}));
    it("every planned source (files / docker-volume / sqlite / postgresql) parses with the UPSTREAM DatabaseConfigFormSchema", () => {
        expect(plan.sources.map((s) => s.dbms).sort()).toEqual(["docker-volume", "files", "files", "postgresql", "sqlite"]);
        for (const s of plan.sources) {
            const cfg = s.needsSecret ? {...s.config, password: "x"} : s.config;
            const r = DatabaseConfigFormSchema.safeParse({name: s.memberName, dbms: s.dbms, config: cfg});
            expect(r.success, `${s.dbms}: ${r.success ? "" : JSON.stringify(r.error.issues)}`).toBe(true);
        }
    });
    it("generated configs are already in upstream's persisted shape (pruneAgentConfig / splitMethod are no-ops) and never carry method or container_name", () => {
        for (const s of plan.sources) {
            expect(pruneAgentConfig(s.config)).toEqual(s.config);
            expect(splitMethod(s.config)).toEqual({config: s.config});
            expect(JSON.stringify(s.config)).not.toMatch(/container_name|method/);
        }
    });
    it("stack project slug is unique per name even when upstream's slugify collides", () => {
        expect(stackProjectSlug("stack:a/bc")).not.toBe(stackProjectSlug("stack:ab/c"));
        expect(stackProjectSlug("stack:prod/My App!")).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
    });
});

describe("upstream tables/columns the adapter relies on", () => {
    const cols = (t: object) => Object.keys(getTableColumns(t as never));
    it.each([
        ["databases", database, ["id", "agentDatabaseId", "name", "dbms", "backupPolicy", "config", "backupEngine", "projectId", "agentId", "lastContact", "deletedAt", "createdAt"]],
        ["projects", project, ["id", "slug", "name", "backupPolicy", "organizationId", "deletedAt"]],
        ["retention_policies", retentionPolicy, ["databaseId", "projectId", "type"]],
        ["storage_policy", storagePolicy, ["storageChannelId", "databaseId", "projectId", "enabled"]],
        ["agents", agent, ["id", "name", "version", "lastContact", "organizationId", "isArchived", "deletedAt"]],
        ["settings", setting, ["encryption"]],
    ] as const)("%s has the columns used by src/fork/upstream", (_n, table, want) => {
        for (const c of want) expect(cols(table), c).toContain(c);
    });
    it("upstream effective-policy resolution is `db ?? project` and null when neither has one (what D30 enforces)", () => {
        const db = {backupPolicy: null, retentionPolicy: null, project: {backupPolicy: null, retentionPolicy: null}} as never;
        expect(resolveBackupCron(db)).toBeNull();
        expect(resolveRetentionPolicy(db)).toBeNull();
        expect(resolveBackupCron({backupPolicy: null, project: {backupPolicy: "0 3 * * *"}} as never)).toBe("0 3 * * *");
        expect(resolveBackupCron({backupPolicy: "1 1 * * *", project: {backupPolicy: "0 3 * * *"}} as never)).toBe("1 1 * * *");
    });
    it("master-key accessor and the trigger-without-cron path exist upstream (D14, ADR-001 §A)", () => {
        expect(readFileSync(path.join(root, "src/features/agents/utils/keys.server.ts"), "utf8")).toMatch(/export async function getMasterServerKeyContent/);
        expect(readFileSync(path.join(root, "src/features/database/actions/bulk-backup.action.ts"), "utf8")).toMatch(/status:\s*"waiting"|waiting/);
    });
});
