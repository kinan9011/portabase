import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {getTableColumns} from "drizzle-orm";
import {describe, expect, it} from "vitest";
import {backup, database, restoration} from "@/db/schema/07_database";
import {backupStorage} from "@/db/schema/14_storage-backup";

/**
 * D31 CONTRACT TESTS for `src/fork/upstream/backups.ts` — run on EVERY W-SYNC. A failure after an upstream merge means: re-diff the
 * upstream file against our copy, adapt `src/fork/upstream/backups.ts` in the SAME sync PR, then update the pinned hash.
 */
const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const sha = (p: string) => createHash("sha256").update(readFileSync(path.join(root, p))).digest("hex");

describe("pinned upstream sources behind the stack-run copies (re-review on change)", () => {
    const PINS: [string, string, string][] = [
        ["src/features/database/actions/bulk-backup.action.ts", "d90906f9a15fd6090e29567452619f417e57b06fafab4be79fbc2a012f9af3b4", "queueWaitingBackups (the waiting|ongoing / method_conflict guards + the `waiting` insert, D14)"],
        ["src/lib/tasks/database/utils/backup-delete.service.ts", "3fbdf5d566607fb0c61b554e040d0cfc4c2f065196c5918534c3dad059af0ce6", "deleteBackupViaUpstream (D33 prune path)"],
        ["src/lib/tasks/database/utils/delete.ts", "cccd05c211aa8c103d0e722a62bc3d702433d5b5c16cf4c275208cc6d27986fa", "deleteBackupViaUpstream (the action wraps the service)"],
        ["src/lib/tasks/cleaning/index.ts", "b0aa1dc32c74925a2213707e44469f372ce9ce1a62db5936fadcfcda15a52abd", "tracker: failed backups are soft-deleted, stale ongoing ⇒ failed (read by id incl. deleted rows)"],
        ["app/api/agent/[agentId]/backup/route.ts", "82e345541a6d3dce381bda4200686b8c857d2f2f6adb8352521dd6681945a322", "tracker: the agent PATCH sets status/fileSize/durationMs; `automatic` inserts an ongoing row"],
        ["app/api/agent/[agentId]/backup/upload/status/route.ts", "14f6a2620ebc0101375b3daa6a78562ccc9f2409cb7f104df3f38dd66695318f", "finaliser: backup_storage status/path/size/stats written by the agent; NO checksum on this path"],
        ["src/features/storages/utils/storages.helpers.ts", "8fda863922e57d8b67499cc846253a5bd29f4ec173f637c9c5f7e20c1aec688d", "finaliser: only the tus path computes a checksum"],
        ["src/db/schema/14_storage-backup.ts", "f9e8c91720b5f54b3af8480d34a2d8c0f14c679a9ceb354878cd092b3e55c7c4", "readBackupFacts columns"],
    ];
    it.each(PINS)("%s unchanged since the copy was made (%s)", (file, hash, copy) => {
        expect(sha(file), `upstream ${file} changed: re-diff ${copy}, adapt it, then update this pin`).toBe(hash);
    });
});

describe("upstream columns the adapter reads/writes", () => {
    it("backups / backup_storage / restorations / databases", () => {
        expect(Object.keys(getTableColumns(backup))).toEqual(expect.arrayContaining(["id", "status", "file", "fileSize", "durationMs", "databaseId", "createdAt", "updatedAt", "deletedAt"]));
        expect(Object.keys(getTableColumns(backupStorage))).toEqual(expect.arrayContaining(["id", "backupId", "storageChannelId", "status", "path", "size", "checksum", "engine", "presence", "updatedAt", "deletedAt"]));
        expect(Object.keys(getTableColumns(restoration))).toEqual(expect.arrayContaining(["backupId", "status"]));
        expect(Object.keys(getTableColumns(database))).toEqual(expect.arrayContaining(["methodConflict", "deletedAt", "agentDatabaseId"]));
    });
    it("the D14 trigger statement is still `insert backups(database_id, status='waiting')` guarded by waiting|ongoing and method_conflict", () => {
        const src = read("src/features/database/actions/bulk-backup.action.ts");
        expect(src).toMatch(/inArray\(drizzleDb\.schemas\.backup\.status, \["waiting", "ongoing"\]\)/);
        expect(src).toMatch(/isNotNull\(drizzleDb\.schemas\.database\.methodConflict\)/);
        expect(src).toMatch(/status: "waiting" as const/);
    });
    it("the agent upload path still writes NO checksum (so the dashboard must hash the object itself)", () => {
        expect(read("app/api/agent/[agentId]/backup/upload/status/route.ts")).not.toMatch(/checksum/);
    });
});
