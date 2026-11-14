"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {deleteMirrorAction} from "@/fork/actions/mirror.action";
import {DangerousActionConfirm} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {MIRRORS, retryText} from "@/fork/ui/mirrors/labels";
import type {Action} from "@/fork/ui/mirrors/model";
import {useAnnounce} from "@/fork/ui/status-announcer";

const L = MIRRORS.lifecycle;
const dataOf = (r: unknown): Record<string, unknown> | null => { const d = (r as {data?: unknown} | undefined)?.data; return d && typeof d === "object" ? (d as Record<string, unknown>) : null; };

/**
 * Delete a test mirror (typed confirmation = the mirror name, plan-W23 DD-6). The server does the work: it marks the mirror deleting; the runner copy is removed and checked by the tick.
 * Blocked states show a visible reason (`aria-disabled`, not hover). Refusals are read from `r.data` (the action wrapper) and shown in `role="alert"`.
 */
export function DeleteMirrorButton({mirrorId, name, runner, action, onDone}: {mirrorId: string; name: string; runner: string; action: Action; onDone?: () => void}) {
    const announce = useAnnounce();
    const router = useRouter();
    const [open, setOpen] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    if ("hidden" in action) return null;
    const reason = "reason" in action ? action.reason : null;
    const confirm = async (typed?: string) => {
        if (busy) return;
        setBusy(true); setErr(null);
        try {
            const d = dataOf(await deleteMirrorAction({mirrorId, confirmName: typed ?? name}));
            if (d?.ok === true) { announce(L.deleted); setOpen(false); onDone?.(); router.refresh(); } else { const t = d ? retryText(d.code, d.retryAfterSeconds) : L.failed; setErr(t); announce(t); setOpen(false); }
        } catch { setErr(L.failed); announce(L.failed); setOpen(false); } finally { setBusy(false); }
    };
    return (
        <span className="inline-flex flex-col items-start gap-1">
            <ReasonButton type="button" variant="outline" size="sm" reason={reason} onClick={() => setOpen(true)} data-testid="mirror-delete" aria-label={`${L.delete} ${name}`}>{busy ? L.working : L.delete}</ReasonButton>
            <DangerousActionConfirm title={L.deleteTitle(name)} description={<>{L.deleteBody(runner)} <span className="block pt-2">Mirror name: <strong className="break-all">{name}</strong></span></>} confirmLabel={L.deleteConfirm}
                open={open} onOpenChange={setOpen} typedPhrase={name} inputLabel={L.deleteInput} typedReason={L.deleteMismatch} onConfirm={(t) => void confirm(t)}/>
            {err && <span role="alert" data-testid="delete-error" className="max-w-64 text-xs">{err}</span>}
        </span>
    );
}
