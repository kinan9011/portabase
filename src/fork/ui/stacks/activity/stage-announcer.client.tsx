"use client";

import * as React from "react";
import type {AnyRunStep} from "@/fork/runs/vocab";
import {ACTIVITY, RUNS} from "@/fork/ui/labels";
import {useAnnounce} from "@/fork/ui/status-announcer";

/**
 * Feeds the page's ONE `role="status"` region (§8.2 rule 7) when the durable server state changes between two polls: the active stage moved, or the
 * run reached a final state. It announces what the server SAID (props come from the polled page), never a guess. Renders nothing.
 */
export function StageAnnouncer({stage, runId, finalState}: {stage: AnyRunStep | null; runId: string | null; finalState: keyof typeof RUNS.states | null}) {
    const announce = useAnnounce();
    const prev = React.useRef<{runId: string | null; stage: AnyRunStep | null; finalState: string | null} | null>(null);
    React.useEffect(() => {
        const p = prev.current;
        prev.current = {runId, stage, finalState};
        if (!p) return; // first render: nothing changed yet
        if (stage && (p.runId !== runId || p.stage !== stage)) announce(ACTIVITY.announce(ACTIVITY.stage[stage]));
        else if (!stage && p.stage && finalState && p.runId === runId) announce(`Backup finished: ${RUNS.states[finalState]}`);
    }, [stage, runId, finalState, announce]);
    return null;
}
