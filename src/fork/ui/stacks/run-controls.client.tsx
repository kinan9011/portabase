"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {cancelStackRunAction, startStackRunAction} from "@/fork/actions/stack-run.action";
import type {RunActionResult} from "@/fork/runs/run-service";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {GENERIC_FAILURE, RUNS} from "@/fork/ui/labels";
import {normalise} from "@/fork/ui/stacks/wizard/outcome";
import {useAnnounce} from "@/fork/ui/status-announcer";

const POLL_MS = 5000;

/** Polling-only run progress (UX-13, CH-32): while the server says a run is active, re-render every 5 s; stops by itself. */
export function RunPoller({active}: {active: boolean}) {
    const router = useRouter();
    React.useEffect(() => {
        if (!active) return;
        const t = setInterval(() => router.refresh(), POLL_MS);
        return () => clearInterval(t);
    }, [active, router]);
    return null;
}

/**
 * "Back up now" / "Run first backup" (W12). Real only when the server-derived `reason` is empty; otherwise visibly disabled with the reason
 * (§8.2 rule 10). The outcome is shown in plain words in the page's single status region, from what the server ANSWERED — a click is never
 * reported as success unless a run row exists.
 */
export function RunNowButton({stackId, label, reason, testId}: {stackId: string; label: string; reason: string | null; testId?: string}) {
    const router = useRouter();
    const announce = useAnnounce();
    const [pending, setPending] = React.useState(false);
    const [msg, setMsg] = React.useState<{ok: boolean; text: string} | null>(null);
    const onClick = async () => {
        if (pending) return;
        setPending(true);
        try {
            const r = normalise<RunActionResult>(await startStackRunAction({stackId}) as never);
            const text = r.kind === "ok" ? RUNS.action.outcome.started
                : r.kind === "refused" ? (RUNS.action.outcome[r.code as keyof typeof RUNS.action.outcome] ?? GENERIC_FAILURE) : GENERIC_FAILURE;
            setMsg({ok: r.kind === "ok", text});
            announce(text);
            if (r.kind === "ok" || (r.kind === "refused" && (r.code === "reauth_failed" || r.code === "already_running"))) router.refresh();
        } catch {
            setMsg({ok: false, text: GENERIC_FAILURE});
        } finally {
            setPending(false);
        }
    };
    return (
        <span className="inline-flex flex-col items-start gap-1">
            <ReasonButton type="button" variant="outline" reason={reason} onClick={onClick} aria-busy={pending || undefined} data-testid={testId ?? "run-now"}>{pending ? RUNS.action.running : label}</ReasonButton>
            {msg && <span data-testid="run-now-outcome" className={`max-w-64 text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</span>}
        </span>
    );
}

export function CancelRunButton({runId}: {runId: string}) {
    const router = useRouter();
    const announce = useAnnounce();
    const [pending, setPending] = React.useState(false);
    return (
        <ReasonButton type="button" variant="outline" size="sm" reason={null} aria-busy={pending || undefined} data-testid="cancel-run" onClick={async () => {
            if (pending) return;
            setPending(true);
            try {
                const r = await cancelStackRunAction({runId});
                const ok = !!(r?.data as {ok?: boolean} | undefined)?.ok;
                announce(ok ? RUNS.action.cancelled : GENERIC_FAILURE);
                router.refresh();
            } catch {
                announce(GENERIC_FAILURE);
            } finally {
                setPending(false);
            }
        }}>{RUNS.action.cancel}</ReasonButton>
    );
}
