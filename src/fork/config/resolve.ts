import {eq} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {forkRestoreOverride} from "@/fork/db/schema/restore-override";
import {buildOverridePayload} from "./override";
import {decryptStored, purgeRestoreOverrides} from "./service";
import type {OverrideError} from "./vocab";

/**
 * W16b: the ONLY consumer of a stored override set (`enqueueRestoreTask` calls it AFTER its own `restore.execute` gate + `loadFreshPlan`; no ACL here).
 * It decrypts under the row's AAD (a copied envelope fails closed), checks the plan-hash binding, rebuilds the task payload through the same pure merge
 * as set time (never trusts a stored derived form) and returns the plaintext payload to its caller IN MEMORY only. Nothing here is audited or logged with a value.
 */
export type ResolvedOverrides = {
    rowId: string; revision: number; restoreId: string | null; renderTaskId: string | null; frozen: boolean;
    payload: {env: Record<string, string>; overrideYml: string | null};
};
export type ResolveResult = {ok: true; value: ResolvedOverrides | null} | {ok: false; code: "hash_mismatch" | "overrides_unreadable" | OverrideError};

export async function resolveOverridesForEnqueue(db: ForkDb, a: {planId: string; planHash: string; now: Date; kekDir?: string}): Promise<ResolveResult> {
    const [row] = await db.select().from(forkRestoreOverride).where(eq(forkRestoreOverride.planId, a.planId));
    if (!row) return {ok: true, value: null};
    if (row.expiresAt.getTime() <= a.now.getTime()) {
        await purgeRestoreOverrides(db, a.planId, "expired", a.now);
        return {ok: true, value: null};
    }
    if (row.planHash !== a.planHash) return {ok: false, code: "hash_mismatch"};
    const stored = await decryptStored(row, a.kekDir);
    if (!stored) return {ok: false, code: "overrides_unreadable"};
    const built = buildOverridePayload(stored);
    if (!built.ok) return {ok: false, code: built.code};
    return {ok: true, value: {rowId: row.id, revision: row.revision, restoreId: row.restoreId, renderTaskId: row.renderTaskId, frozen: !!row.frozenAt, payload: {env: built.env, overrideYml: built.overrideYml}}};
}
