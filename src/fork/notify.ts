import {forkNotificationOutbox} from "@/fork/db/schema/ops";
import type {ForkDb} from "@/fork/db/handle";

/**
 * Durable notification record (one per state change via `dedupe_key`). Bodies are state + link only (§4.7): never names,
 * ids, paths or secrets — `payload` carries stable codes. Delivery through upstream notification channels is W13; until
 * then rows stay `pending` and the UI must not claim anything was sent.
 */
export async function enqueueForkNotification(db: ForkDb, n: {kind: string; dedupeKey: string; payload?: Record<string, unknown>}): Promise<boolean> {
    const rows = await db.insert(forkNotificationOutbox).values({kind: n.kind, dedupeKey: n.dedupeKey, payload: n.payload ?? {}}).onConflictDoNothing().returning({id: forkNotificationOutbox.id});
    return rows.length === 1;
}
