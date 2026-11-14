import type {ForkDb} from "@/fork/db/handle";
import {forkMirrorEvent} from "@/fork/db/schema/mirror";
import type {EventKind} from "./vocab";

/** Per-mirror timeline row (W23 shows it; the audit log stays the security record). `details` = ids, codes, counts only (≤ 4 KiB by CHECK). */
export async function addEvent(db: ForkDb, e: {mirrorId: string; revisionId: string | null; kind: EventKind; at: Date; fromState?: string | null; toState?: string | null; code?: string | null;
    actor?: {userId: string} | null; details?: Record<string, unknown>}): Promise<void> {
    await db.insert(forkMirrorEvent).values({
        mirrorId: e.mirrorId, revisionId: e.revisionId, kind: e.kind, fromState: e.fromState ?? null, toState: e.toState ?? null, code: e.code ?? null,
        actorKind: e.actor ? "user" : "system", actorUserId: e.actor?.userId ?? null, at: e.at, details: e.details ?? {},
    });
}
