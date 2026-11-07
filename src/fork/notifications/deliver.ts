import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {renderNotification} from "./render";
import {
    backoffMs, CLAIM_LEASE_MS, isDeliverableKind, MAX_ATTEMPTS, NO_CHANNEL_GIVE_UP_MS, NO_CHANNEL_RECHECK_MS, type DeliveryErrorCode,
} from "./vocab";

/**
 * Outbox delivery (W13, §4.7). One pass: claim due rows (short transaction, `FOR UPDATE SKIP LOCKED`, lease in `claimed_until` so two replicas never take
 * the same row), render each body from codes (`render.ts`), send through the upstream default channel OUTSIDE any transaction, then record the real outcome:
 *   delivered (only after the provider answered ok) · retry with backoff · `failed` with a closed code after `MAX_ATTEMPTS` · `no_channel` waits (rechecked,
 *   gives up after 24 h, never claims "sent") · non-§4.7 kinds are `suppressed`. At-least-once: a crash between send and mark can repeat ONE notification.
 * Runs in `on` AND `locked` mode (notifications keep working in degraded mode, ADR-010).
 */
export type DeliverDeps = {
    db: ForkDb;
    now?: () => Date;
    baseUrl?: string | null;
    resolveChannel: (db: ForkDb) => Promise<{id: string; organizationId: string | null} | null>;
    send: (channel: {id: string; organizationId: string | null}, m: {title: string; message: string; level: "critical" | "warning" | "info"; event: "error_backup" | "error_backup_missing" | "success_backup_recovered"}) => Promise<boolean>;
    batch?: number;
};
export type DeliverResult = {claimed: number; delivered: number; retried: number; failed: number; suppressed: number; waitingNoChannel: number};

type Row = {id: string; kind: string; payload: unknown; attempts: number; created_at: Date};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function deliverPending(d: DeliverDeps): Promise<DeliverResult> {
    const now = d.now?.() ?? new Date();
    const out: DeliverResult = {claimed: 0, delivered: 0, retried: 0, failed: 0, suppressed: 0, waitingNoChannel: 0};
    const lease = new Date(now.getTime() + CLAIM_LEASE_MS);
    const claimed = await d.db.execute(sql`
        update fork_notification_outbox set claimed_until = ${lease.toISOString()}
         where id in (select id from fork_notification_outbox
                       where state = 'pending' and next_attempt_at <= ${now.toISOString()} and (claimed_until is null or claimed_until < ${now.toISOString()})
                       order by created_at, id limit ${d.batch ?? 20} for update skip locked)
        returning id, kind, payload, attempts, created_at`);
    const rows = claimed.rows as Row[];
    out.claimed = rows.length;
    if (rows.length === 0) return out;

    let channel: Awaited<ReturnType<DeliverDeps["resolveChannel"]>> = null;
    let channelResolved = false;
    for (const r of rows) {
        if (!isDeliverableKind(r.kind)) {
            await d.db.execute(sql`update fork_notification_outbox set state = 'suppressed', claimed_until = null where id = ${r.id}`);
            out.suppressed++;
            continue;
        }
        if (!channelResolved) { channel = await d.resolveChannel(d.db); channelResolved = true; }
        if (!channel) {
            const age = now.getTime() - new Date(r.created_at).getTime();
            if (age >= NO_CHANNEL_GIVE_UP_MS) { await fail(d.db, r.id, "no_channel", r.attempts); out.failed++; }
            else {
                await d.db.execute(sql`update fork_notification_outbox set claimed_until = null, last_error_code = 'no_channel', next_attempt_at = ${new Date(now.getTime() + NO_CHANNEL_RECHECK_MS).toISOString()} where id = ${r.id}`);
                out.waitingNoChannel++;
            }
            continue;
        }
        let ok = false;
        let code: DeliveryErrorCode = "provider_error";
        try {
            const stackId = typeof (r.payload as {stackId?: unknown} | null)?.stackId === "string" && UUID.test((r.payload as {stackId: string}).stackId) ? (r.payload as {stackId: string}).stackId : null;
            let stackName: string | null = null;
            if (stackId) {
                const s = await d.db.execute(sql`select display_name from fork_stack where id = ${stackId}`);
                stackName = (s.rows[0] as {display_name: string} | undefined)?.display_name ?? null;
            }
            const body = renderNotification({kind: r.kind, payload: r.payload, stackName, baseUrl: d.baseUrl ?? null});
            if (!body) { code = "render_error"; }
            else ok = await d.send(channel, body);
        } catch {
            ok = false;
        }
        if (ok) {
            await d.db.execute(sql`update fork_notification_outbox set state = 'delivered', delivered_at = ${now.toISOString()}, claimed_until = null, attempts = attempts + 1, last_error_code = null where id = ${r.id}`);
            out.delivered++;
            continue;
        }
        const attempts = r.attempts + 1;
        if (code === "render_error" || attempts >= MAX_ATTEMPTS) { await fail(d.db, r.id, code, attempts); out.failed++; }
        else {
            await d.db.execute(sql`update fork_notification_outbox set attempts = ${attempts}, claimed_until = null, last_error_code = ${code}, next_attempt_at = ${new Date(now.getTime() + backoffMs(attempts)).toISOString()} where id = ${r.id}`);
            out.retried++;
        }
    }
    return out;
}

async function fail(db: ForkDb, id: string, code: DeliveryErrorCode, attempts: number): Promise<void> {
    await db.execute(sql`update fork_notification_outbox set state = 'failed', claimed_until = null, attempts = ${attempts}, last_error_code = ${code} where id = ${id}`);
}
