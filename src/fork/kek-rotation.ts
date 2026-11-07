import {sql} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import {connectionAad} from "@/fork/db/dto";
import type {ForkDb} from "@/fork/db/handle";
import {decryptWith, defaultKekDir, encryptWith, getOrCreateKeyring, loadKeyring, rotateForkKek, type ForkSecretAad} from "@/fork/kek";

/**
 * Fork KEK rotation + re-encrypt (ADR-013 §4, W04/W05 follow-up). `rotateForkKek` only ADDS a key; this module moves every envelope onto it:
 * per row, decrypt with whatever kid it carries, encrypt with the active key, DECRYPT AGAIN to prove it, then write — one transaction per row under a row lock, so a
 * crash leaves each row either fully old or fully new and both kids stay in the keyring. Old keys are NEVER removed here (removing a key before the kit is
 * re-issued and verified would destroy data: operator decision, documented in ADR-006).
 *
 * `ENVELOPE_COLUMNS` is the registry of every column that holds a fork-KEK envelope; `w14-static` fails if the fork schema gains an `*_enc` column that is
 * not listed here.
 */
export type EnvelopeColumn = {table: string; idColumn: string; column: string; aad: (id: string) => ForkSecretAad};
export const ENVELOPE_COLUMNS: readonly EnvelopeColumn[] = [
    {table: "fork_arcane_connection", idColumn: "id", column: "api_key_enc", aad: connectionAad},
    // W15: per-agent task key (jsonb envelope). A kit-less KEK loss means re-enrolling the agents (ADR-007 D4).
    {table: "fork_agent_enrollment", idColumn: "id", column: "task_key_enc", aad: (id) => ({table: "fork_agent_enrollment", rowId: id, column: "task_key_enc"})},
];

export type ReencryptResult = {rows: number; moved: number; failed: number};

export async function reencryptForkSecrets(db: ForkDb, kekDir = defaultKekDir()): Promise<ReencryptResult> {
    const ring = await loadKeyring(kekDir);
    if (!ring) return {rows: 0, moved: 0, failed: 0};
    const out: ReencryptResult = {rows: 0, moved: 0, failed: 0};
    for (const c of ENVELOPE_COLUMNS) {
        // identifiers come from the constant registry above, never from input
        const ids = (await db.execute(sql.raw(`select ${c.idColumn}::text as id from ${c.table}`))).rows as {id: string}[];
        for (const {id} of ids) {
            out.rows++;
            try {
                await db.transaction(async (tx) => {
                    const t = tx as unknown as ForkDb;
                    const r = (await t.execute(sql.raw(`select ${c.column} as env from ${c.table} where ${c.idColumn} = '${id.replace(/[^0-9a-f-]/gi, "")}'::uuid for update`))).rows[0] as {env: {kid?: string}} | undefined;
                    if (!r) return;
                    if (r.env?.kid === ring.active) return;
                    const aad = c.aad(id);
                    const plain = decryptWith(ring, r.env, aad);
                    const next = encryptWith(ring, plain, aad);
                    if (decryptWith(ring, next, aad) !== plain) throw new Error("verify");
                    await t.execute(sql`${sql.raw(`update ${c.table} set ${c.column} = `)}${JSON.stringify(next)}::jsonb${sql.raw(` where ${c.idColumn} = '${id.replace(/[^0-9a-f-]/gi, "")}'::uuid`)}`);
                    out.moved++;
                });
            } catch { out.failed++; } // the row keeps its old (still decryptable) envelope; the count is reported, never the content
        }
    }
    return out;
}

export type RotateResult = {ok: true; newKid: string; previousKid: string; rows: number; moved: number; failed: number};

/** Adds a new key, makes it active and re-encrypts. The caller (kit service) authorises, steps up, audits and marks the kit stale. */
export async function rotateKekAndReencrypt(db: ForkDb, kekDir = defaultKekDir(), audit?: {actorUserId: string | null; now?: Date}): Promise<RotateResult> {
    await getOrCreateKeyring(kekDir);
    const {kid, previous} = await rotateForkKek(kekDir);
    const r = await reencryptForkSecrets(db, kekDir);
    if (audit) await recordAudit(db, {actorUserId: audit.actorUserId, action: "fork.kek.rotate", resourceType: "fork_kek", result: r.failed === 0 ? "success" : "failure", details: {newKid: kid, previousKid: previous, rows: r.rows, moved: r.moved, failed: r.failed}, now: audit.now});
    return {ok: true, newKid: kid, previousKid: previous, ...r};
}
