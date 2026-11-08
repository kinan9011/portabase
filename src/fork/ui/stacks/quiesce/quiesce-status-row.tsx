import {QUIESCE as Q} from "@/fork/ui/labels";

/**
 * W11 wizard: a READ-ONLY status line for "Stop + copy" (no field, no action, no form control — the enable itself is a separate audited admin action on the
 * Schedule tab, so `ActivateInputSchema` is unchanged). `reason` = the closed unavailability code, or null when the host and dashboard are ready.
 */
export function QuiesceStatusRow({reason}: {reason: string | null}) {
    const text = reason === null ? Q.statusRow.available : Q.statusRow.blocked(Object.hasOwn(Q.skip, reason) ? Q.skip[reason as keyof typeof Q.skip] : "");
    return <p data-testid="quiesce-status-row" data-state={reason === null ? "available" : "blocked"} className="text-muted-foreground text-sm"><span aria-hidden="true">{reason === null ? "○" : "▲"} </span>{text}</p>;
}
