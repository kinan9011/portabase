"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {STACKS_PAGE} from "@/fork/ui/labels";
import {useAnnounce} from "@/fork/ui/status-announcer";

export const POLL_MS = 5000;

/**
 * Polling-only progress (UX-13, CH-32; no SSE, no WebSocket). While the server says a sync holds the lease, ask the server
 * to re-render every 5 s; it stops as soon as the lease is gone. The text lives in the page's ONE shared `role="status"` region.
 * Nothing here knows anything about the sync except the boolean the server derived from durable state.
 */
export function SyncPoller({active}: {active: boolean}) {
    const router = useRouter();
    const announce = useAnnounce();
    const was = React.useRef(false);
    React.useEffect(() => {
        if (active) {
            announce(STACKS_PAGE.syncing);
            was.current = true;
            const t = setInterval(() => router.refresh(), POLL_MS);
            return () => clearInterval(t);
        }
        if (was.current) { announce(STACKS_PAGE.syncingDone); was.current = false; }
    }, [active, announce, router]);
    return null;
}
