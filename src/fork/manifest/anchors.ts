import {eq, isNull, sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {forkTrustAnchor} from "@/fork/db/schema/kit";
import {kidOfPublicKey, spkiSha256} from "./sign";
import type {TrustAnchor} from "./verify";

/**
 * Trust-anchor registry (ADR-013 §3, K-4). `registerLiveAnchor` is called with the CURRENT public key (never a private key): a new key retires the
 * previous live anchor — rows are never deleted, so every old manifest keeps verifying. Returns `rotated: true` when the live key changed (the caller marks
 * the kit stale and emits `kit.key_rotated`; the very first registration is not a rotation).
 */
export async function registerLiveAnchor(db: ForkDb, publicKeyPem: string, now = new Date()): Promise<{kid: string; rotated: boolean; previous: string | null}> {
    const kid = kidOfPublicKey(publicKeyPem);
    return db.transaction(async (tx) => {
        const t = tx as unknown as ForkDb;
        await t.execute(sql`select pg_advisory_xact_lock(hashtextextended('fork-trust-anchor', 0))`);
        const live = await t.select().from(forkTrustAnchor).where(isNull(forkTrustAnchor.retiredAt));
        if (live.length === 1 && live[0].kid === kid) return {kid, rotated: false, previous: null};
        const known = await t.select().from(forkTrustAnchor).where(eq(forkTrustAnchor.kid, kid));
        const previous = live[0]?.kid ?? null;
        if (live.length > 0) await t.update(forkTrustAnchor).set({retiredAt: now}).where(isNull(forkTrustAnchor.retiredAt));
        if (known.length > 0) await t.update(forkTrustAnchor).set({retiredAt: null}).where(eq(forkTrustAnchor.kid, kid)); // an old key restored from backup becomes live again
        else await t.insert(forkTrustAnchor).values({kid, publicKeyPem, fingerprint: spkiSha256(publicKeyPem), createdAt: now});
        return {kid, rotated: previous !== null, previous};
    });
}

/** Every public key that ever signed (current + retired): the verifier's trust set. */
export async function loadTrustAnchors(db: ForkDb): Promise<(TrustAnchor & {fingerprint: string; retired: boolean})[]> {
    const rows = await db.select().from(forkTrustAnchor);
    return rows.map((r) => ({kid: r.kid, publicKeyPem: r.publicKeyPem, fingerprint: r.fingerprint, retired: r.retiredAt !== null}));
}
