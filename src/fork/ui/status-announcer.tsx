"use client";

import * as React from "react";

/**
 * ONE shared `role="status"` region (§8.2 rule 7): every job/action result of the page is announced here, in visible text,
 * so the result is both on screen and read by assistive tech. Progress elsewhere is polled from server state (no SSE).
 */
type Announce = (message: string) => void;
const Ctx = React.createContext<Announce>(() => {});
export const useAnnounce = () => React.useContext(Ctx);

export function StatusAnnouncer({children}: {children: React.ReactNode}) {
    const [message, setMessage] = React.useState("");
    return (
        <Ctx.Provider value={setMessage}>
            {children}
            <div role="status" aria-live="polite" aria-atomic="true" data-testid="job-status" className="min-h-5 text-sm text-muted-foreground">{message}</div>
        </Ctx.Provider>
    );
}
