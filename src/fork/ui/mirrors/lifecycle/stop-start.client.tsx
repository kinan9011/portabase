"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {startMirrorAction, stopMirrorAction} from "@/fork/actions/mirror.action";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {MIRRORS, retryText} from "@/fork/ui/mirrors/labels";
import type {Action} from "@/fork/ui/mirrors/model";
import {useAnnounce} from "@/fork/ui/status-announcer";

const L = MIRRORS.lifecycle;
const dataOf = (r: unknown): Record<string, unknown> | null => { const d = (r as {data?: unknown} | undefined)?.data; return d && typeof d === "object" ? (d as Record<string, unknown>) : null; };

/**
 * Stop (confirmed) and Start (no confirm: it only brings back what was already approved, after isolation + health checks) for a test mirror (plan-W23 DD-9). The server marks the mirror
 * `stopping` / `starting`; the tick does the work, the Overview poll shows the outcome. Blocked states show a visible reason (`aria-disabled`, not hover); refusals come from `r.data`.
 */
export function StopStartButtons({mirrorId, name, stop, start, onDone}: {mirrorId: string; name: string; stop: Action; start: Action; onDone?: () => void}) {
    const announce = useAnnounce();
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const run = async (call: () => Promise<unknown>, okText: string) => {
        if (busy) return;
        setBusy(true); setErr(null);
        try {
            const d = dataOf(await call());
            if (d?.ok === true) { announce(okText); onDone?.(); router.refresh(); } else { const t = d ? retryText(d.code, d.retryAfterSeconds) : L.failed; setErr(t); announce(t); }
        } catch { setErr(L.failed); announce(L.failed); } finally { setBusy(false); setOpen(false); }
    };
    return (
        <span className="inline-flex flex-wrap items-start gap-2">
            {!("hidden" in stop) && <>
                <ReasonButton type="button" variant="outline" size="sm" reason={"reason" in stop ? stop.reason : null} onClick={() => setOpen(true)} data-testid="mirror-stop" aria-label={`${L.stop} ${name}`}>{busy ? L.working : L.stop}</ReasonButton>
                <DangerousActionConfirm title={L.stopTitle(name)} description={L.stopBody} confirmLabel={L.stopConfirm} open={open} onOpenChange={setOpen} onConfirm={() => void run(() => stopMirrorAction({mirrorId}), L.stopRequested)}/>
            </>}
            {!("hidden" in start) && <span className="inline-flex flex-col items-start gap-1">
                <ReasonButton type="button" variant="outline" size="sm" reason={"reason" in start ? start.reason : null} onClick={() => void run(() => startMirrorAction({mirrorId}), L.startRequested)} data-testid="mirror-start" aria-label={`${L.start} ${name}`}>{busy ? L.working : L.start}</ReasonButton>
                <span className="text-muted-foreground max-w-64 text-xs">{L.startNote}</span>
            </span>}
            {err && <span role="alert" data-testid="lifecycle-error" className="max-w-64 text-xs">{err}</span>}
        </span>
    );
}
