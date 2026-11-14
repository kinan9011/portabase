import {and, asc, eq} from "drizzle-orm";
import {recordAudit} from "@/fork/audit";
import {forkMirror, forkMirrorRevision} from "@/fork/db/schema/mirror";
import {withForkLock} from "@/fork/locks";
import {nowOf, type MirrorDeps} from "./deps";
import {addEvent} from "./events";
import {advanceMirrorWipe} from "./wipe";
import {ACTIVE_REVISION_STATES} from "./vocab";

/**
 * W23 mirror lifecycle tick (plan-W23 DD-6). `advanceMirrorDeletes`: for every mirror in `deleting`, run the verified wipe of its READY revision(s) (non-ready terminal revisions are handled by the
 * existing wipe phase), and only when EVERY revision's copy is verified gone (or never existed) mark the mirror `deleted` (name reusable, loopback port freed). A failed wipe leaves the mirror
 * `deleting` with the failure visible on its revision (Retry wipe is an explicit, audited action). Needs no principal: removing a production-data copy is always allowed.
 */
export type DeleteTick = {advanced: number; deleted: number; failed: number};
const DONE = ["verified", "not_needed"];

export async function advanceMirrorDeletes(d: MirrorDeps): Promise<DeleteTick> {
    const out: DeleteTick = {advanced: 0, deleted: 0, failed: 0};
    const mirrors = await d.db.select({id: forkMirror.id, organizationId: forkMirror.organizationId}).from(forkMirror).where(eq(forkMirror.status, "deleting")).orderBy(asc(forkMirror.updatedAt)).limit(50);
    for (const m of mirrors) {
        try {
            const load = () => d.db.select({id: forkMirrorRevision.id, state: forkMirrorRevision.state, wipeState: forkMirrorRevision.wipeState}).from(forkMirrorRevision).where(eq(forkMirrorRevision.mirrorId, m.id));
            for (const r of await load()) if (r.state === "ready" && (r.wipeState === null || r.wipeState === "running")) await advanceMirrorWipe(d, r.id);
            const revs = await load();
            if (revs.some((r) => (ACTIVE_REVISION_STATES as readonly string[]).includes(r.state))) { out.advanced += 1; continue; }
            if (revs.some((r) => r.wipeState === "failed")) { out.failed += 1; continue; }
            if (!revs.every((r) => r.wipeState !== null && DONE.includes(r.wipeState))) { out.advanced += 1; continue; }
            const now = nowOf(d);
            const done = await withForkLock(d.db, `mirror:${m.id}`, async (tx) => {
                const rows = await tx.update(forkMirror).set({status: "deleted", deletedAt: now, updatedAt: now}).where(and(eq(forkMirror.id, m.id), eq(forkMirror.status, "deleting"))).returning({id: forkMirror.id});
                if (rows.length !== 1) return false;
                await addEvent(tx, {mirrorId: m.id, revisionId: null, kind: "state_changed", at: now, fromState: "deleting", toState: "deleted", details: {scope: "mirror"}});
                await recordAudit(tx, {organizationId: m.organizationId, actorKind: "system", action: "fork.mirror.delete", resourceType: "mirror", resourceId: m.id, result: "success", now, details: {phase: "done", revisions: revs.length}});
                return true;
            });
            if (done) out.deleted += 1;
        } catch {
            // isolated: the next tick retries (the message is never read or logged)
        }
    }
    return out;
}
