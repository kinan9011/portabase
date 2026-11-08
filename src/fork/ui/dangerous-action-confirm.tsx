"use client";

import * as React from "react";
import {Input} from "@/components/ui/input";
import {AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger} from "@/components/ui/alert-dialog";

/**
 * Controlled copy-and-own confirm (D31, `DangerousActionConfirm` of the UI map) over Radix AlertDialog: focus trap, Escape
 * cancels, focus returns to the trigger, the safe action (Cancel) is focused first. The confirm button is the only way
 * through; `onConfirm` must call a real server action (no fake success). Either pass `trigger` or control `open` yourself.
 */
/**
 * Radix returns focus to its own `Trigger` only. These dialogs are opened from controlled state (the opener is a
 * `ReasonButton`, a select, …), so without this focus would fall to `<body>` on close (keyboard users lose their place).
 * The opener is captured in a layout effect: it runs in the commit that opens the dialog, BEFORE Radix moves focus inside.
 */
export function useReturnFocus(open: boolean | undefined, explicit?: () => HTMLElement | null) {
    const opener = React.useRef<HTMLElement | null>(null);
    React.useLayoutEffect(() => {
        if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }, [open]);
    return {
        onCloseAutoFocus: (e: Event) => {
            e.preventDefault();
            (explicit?.() ?? opener.current)?.focus();
        },
    };
}

export type DangerousActionConfirmProps = {
    title: string;
    description: React.ReactNode;
    confirmLabel: string;
    /** `typed` is the trimmed text of the typed-confirmation field (typed mode only); existing callers ignore it. */
    onConfirm: (typed?: string) => void;
    trigger?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Where focus goes on close when the opener is not what had focus at open time (e.g. a select that has just closed). */
    returnFocus?: () => HTMLElement | null;
    /** W18b B5 typed mode: the confirm button stays `aria-disabled` until the trimmed input equals this phrase exactly. The caller shows the phrase in `description`. */
    typedPhrase?: string;
    inputLabel?: string;
    /** Visible reason shown while the input does not match (disabled-with-reason, §8.2). */
    typedReason?: string;
};

export function DangerousActionConfirm({title, description, confirmLabel, onConfirm, trigger, open, onOpenChange, returnFocus, typedPhrase, inputLabel, typedReason}: DangerousActionConfirmProps) {
    const focus = useReturnFocus(open, returnFocus);
    const reasonId = React.useId();
    const inputId = React.useId();
    const [value, setValue] = React.useState("");
    const typed = typedPhrase !== undefined;
    const match = !typed || value.trim() === typedPhrase;
    // the typed text never outlives the dialog (cleared on any close, controlled or not)
    React.useEffect(() => { if (open === false) setValue(""); }, [open]);
    const change = (next: boolean) => { if (!next) setValue(""); onOpenChange?.(next); };
    return (
        <AlertDialog open={open} onOpenChange={change}>
            {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
            <AlertDialogContent {...(trigger ? {} : focus)}>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription asChild><div className="text-muted-foreground space-y-2 text-sm">{description}</div></AlertDialogDescription>
                </AlertDialogHeader>
                {typed && (
                    <div className="space-y-2">
                        <label htmlFor={inputId} className="text-sm font-medium">{inputLabel}</label>
                        <Input id={inputId} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoComplete="off" data-gramm="false" data-1p-ignore aria-describedby={match ? undefined : reasonId} />
                        {!match && typedReason && <p id={reasonId} className="text-muted-foreground text-sm">{typedReason}</p>}
                    </div>
                )}
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                        aria-disabled={typed ? !match : undefined}
                        onClick={(e) => { if (!match) { e.preventDefault(); return; } const t = typed ? value.trim() : undefined; setValue(""); onConfirm(t); }}
                        className={`bg-destructive hover:bg-destructive/90 text-white${match ? "" : " cursor-not-allowed opacity-50"}`}
                    >{confirmLabel}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
