import {PROTECTION_LABELS, RUNTIME_LABELS, SERVICE_STATE_LABELS, STALE_BADGE} from "@/fork/ui/labels";
import {ToneBadge} from "@/fork/ui/tone-badge";
import type {StackListItem} from "@/fork/stacks/dto";

/**
 * Runtime and protection are TWO independent badges (UI plan §4.6): a running stack can be unprotected, a stopped one can be
 * protected. Colour comes from the one tone map; text always accompanies the icon. The description is inline text, never a tooltip.
 */
export function RuntimeBadge({state, describe = false}: {state: StackListItem["runtime"]; describe?: boolean}) {
    const l = RUNTIME_LABELS[state];
    return (
        <span className="inline-flex flex-col items-start gap-1" data-testid="runtime-badge">
            <ToneBadge tone={l.tone}><span className="sr-only">Runtime: </span>{l.label}</ToneBadge>
            {describe && <span className="text-muted-foreground max-w-prose text-xs">{l.description}</span>}
        </span>
    );
}

export function ProtectionBadge({state, describe = false}: {state: StackListItem["protection"]; describe?: boolean}) {
    const l = PROTECTION_LABELS[state];
    return (
        <span className="inline-flex flex-col items-start gap-1" data-testid="protection-badge">
            <ToneBadge tone={l.tone}><span className="sr-only">Protection: </span>{l.label}</ToneBadge>
            {describe && <span className="text-muted-foreground max-w-prose text-xs">{l.description}</span>}
        </span>
    );
}

export function StaleBadge() {
    return <ToneBadge tone={STALE_BADGE.tone}>{STALE_BADGE.label}</ToneBadge>;
}

export function ServiceStateBadge({state}: {state: keyof typeof SERVICE_STATE_LABELS}) {
    const l = SERVICE_STATE_LABELS[state];
    return <ToneBadge tone={l.tone}>{l.label}</ToneBadge>;
}
