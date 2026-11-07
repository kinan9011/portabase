import {createHash, randomBytes} from "node:crypto";
import {and, eq, gt, isNull, lt} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {forkKitToken} from "@/fork/db/schema/kit";

/**
 * Single-use grants for the kit routes (ADR-013 K-8). The raw token exists only in the step-up response and in the one form POST that spends it; the DB
 * holds SHA-256 only. A grant is bound to the user and to ONE kind, expires in minutes, and is consumed atomically (an UPDATE … RETURNING, so two racing
 * requests cannot both win).
 */
export const KIT_TOKEN_TTL_MS = 5 * 60_000;
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

export async function issueKitToken(db: ForkDb, userId: string, kind: "paper" | "digital", now = new Date()): Promise<string> {
    const raw = randomBytes(32).toString("base64url");
    await db.delete(forkKitToken).where(lt(forkKitToken.expiresAt, new Date(now.getTime() - 3600_000))); // housekeeping
    await db.insert(forkKitToken).values({tokenHash: hash(raw), userId, kind, createdAt: now, expiresAt: new Date(now.getTime() + KIT_TOKEN_TTL_MS)});
    return raw;
}

export async function consumeKitToken(db: ForkDb, userId: string, kind: "paper" | "digital", raw: string, now = new Date()): Promise<boolean> {
    if (typeof raw !== "string" || raw.length < 20 || raw.length > 100) return false;
    const r = await db.update(forkKitToken).set({consumedAt: now})
        .where(and(eq(forkKitToken.tokenHash, hash(raw)), eq(forkKitToken.userId, userId), eq(forkKitToken.kind, kind), isNull(forkKitToken.consumedAt), gt(forkKitToken.expiresAt, now)))
        .returning({id: forkKitToken.id});
    return r.length === 1;
}
