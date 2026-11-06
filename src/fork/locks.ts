import {sql} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {forkLock} from "@/fork/db/schema/ops";

/**
 * ARCH-10 DB-level locks.
 *  - `withForkLock`: transaction-scoped advisory lock — short critical sections (RP finaliser assigning `sequence`, audit
 *    chain append). Released by commit/rollback/crash, so it can never leak.
 *  - leases (`fork_lock`): for work that outlives a transaction (a stack run). Expire on their own; only the owner releases.
 */
export async function withForkLock<T>(db: ForkDb, key: string, fn: (tx: ForkDb) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
        return fn(tx as unknown as ForkDb);
    });
}

/** Non-blocking variant: `{acquired:false}` when another transaction holds the key. */
export async function tryWithForkLock<T>(db: ForkDb, key: string, fn: (tx: ForkDb) => Promise<T>): Promise<{acquired: true; value: T} | {acquired: false}> {
    return db.transaction(async (tx) => {
        const r = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as ok`);
        if (!(r.rows[0] as {ok: boolean}).ok) return {acquired: false as const};
        return {acquired: true as const, value: await fn(tx as unknown as ForkDb)};
    });
}

/** Takes (or renews, if already owned) the named lease; steals it only after expiry. */
export async function acquireLease(db: ForkDb, name: string, owner: string, ttlMs: number, now = new Date()): Promise<boolean> {
    const expires = new Date(now.getTime() + ttlMs);
    const rows = await db.execute(sql`
        insert into fork_lock (name, owner, acquired_at, expires_at) values (${name}, ${owner}, ${now}, ${expires})
        on conflict (name) do update set owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
        where fork_lock.expires_at < ${now} or fork_lock.owner = excluded.owner
        returning name`);
    return rows.rows.length === 1;
}

/** Releases the lease only if `owner` still holds it. */
export async function releaseLease(db: ForkDb, name: string, owner: string): Promise<boolean> {
    const rows = await db.execute(sql`delete from fork_lock where name = ${name} and owner = ${owner} returning name`);
    return rows.rows.length === 1;
}

export {forkLock};
