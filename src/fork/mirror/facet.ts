import {and, desc, eq, isNotNull} from "drizzle-orm";
import type {ForkDb} from "@/fork/db/handle";
import {forkMirrorRevision} from "@/fork/db/schema/mirror";

/**
 * The "App start-tested" fact (ADR-016, #200 dash half): the newest `ready` revision of the stack. A READY row exists only after all five gates passed (CHECK `ready` needs the final view, the
 * spec, the probe task and `readied_at`). W23 applies the decay window and words it ("started", never "restore-tested" or "verified"). The fact is NEVER derived from `up` exit 0, a `starting` health
 * state, a skipped probe or lab-only product state.
 */
export type StartTestedFact = {rpId: string | null; rpSequence: number; revisionId: string; readiedAt: Date; durationSeconds: number | null};

export async function startTestedFact(db: ForkDb, stackId: string): Promise<StartTestedFact | null> {
    const [r] = await db.select({rpId: forkMirrorRevision.rpId, rpSequence: forkMirrorRevision.rpSequence, id: forkMirrorRevision.id, readiedAt: forkMirrorRevision.readiedAt, durationSeconds: forkMirrorRevision.durationSeconds})
        .from(forkMirrorRevision).where(and(eq(forkMirrorRevision.stackId, stackId), eq(forkMirrorRevision.state, "ready"), isNotNull(forkMirrorRevision.readiedAt)))
        .orderBy(desc(forkMirrorRevision.readiedAt)).limit(1);
    return r && r.readiedAt ? {rpId: r.rpId, rpSequence: r.rpSequence, revisionId: r.id, readiedAt: r.readiedAt, durationSeconds: r.durationSeconds} : null;
}
