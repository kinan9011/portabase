import {logger} from "@/lib/logger";
import {purgeAuditEvents, recordAudit, verifyAuditChain} from "@/fork/audit";
import type {ForkDb} from "@/fork/db/handle";
import {appDb} from "@/fork/db/handle";
import {registerForkRuntimeTask} from "@/fork/runtime";

const log = logger.child({module: "fork/audit-task"});
const EVERY_MS = 6 * 60 * 60 * 1000;
const VERIFY_EVERY_MS = 24 * 60 * 60 * 1000;
let lastVerifyAt = 0;

/**
 * W27a F-06 (OD-W27-13): the hash chain is tamper-EVIDENT only if someone runs the verification. Daily (inside the retention run): a broken chain writes ONE failure audit event
 * `fork.audit.chain_broken` (first bad seq + reason, never row content) and a fixed log sentence. No notification kind (the vocabulary is closed). Returns whether it ran.
 */
export async function verifyAuditChainDaily(db: ForkDb, now = new Date(), force = false): Promise<{ran: boolean; ok: boolean | null}> {
    if (!force && now.getTime() - lastVerifyAt < VERIFY_EVERY_MS) return {ran: false, ok: null};
    lastVerifyAt = now.getTime();
    const rep = await verifyAuditChain(db);
    if (!rep.ok) {
        await recordAudit(db, {actorKind: "system", action: "fork.audit.chain_broken", resourceType: "audit_chain", result: "failure", details: {first_bad_seq: rep.badSeq ?? null, reason: rep.reason ?? null, checked: rep.checked}, now});
        log.error("fork: audit chain verification failed");
    }
    return {ran: true, ok: rep.ok};
}

/**
 * SEC-07 retention runner. Plane `runtime`: keeps running in "locked" mode (it never changes configuration). Idempotent
 * registration (init can run twice in dev). The timer is unref'd so it never keeps the process alive.
 */
export function registerAuditRetentionTask(): void {
    try {
        registerForkRuntimeTask({
            name: "fork-audit-retention",
            plane: "runtime",
            start: () => {
                const run = async () => {
                    try {
                        const db = await appDb();
                        const {purged} = await purgeAuditEvents(db);
                        if (purged > 0) log.info({purged}, "Fork audit retention purge");
                        await verifyAuditChainDaily(db);
                    } catch (error) {
                        log.error({error: error instanceof Error ? error.name : "unknown"}, "Fork audit retention purge failed");
                    }
                };
                setTimeout(run, 60_000).unref();
                setInterval(run, EVERY_MS).unref();
            },
        });
    } catch {
        // already registered
    }
}
