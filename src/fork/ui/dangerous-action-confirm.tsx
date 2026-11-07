"use client";

import * as React from "react";
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
    onConfirm: () => void;
    trigger?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Where focus goes on close when the opener is not what had focus at open time (e.g. a select that has just closed). */
    returnFocus?: () => HTMLElement | null;
};

export function DangerousActionConfirm({title, description, confirmLabel, onConfirm, trigger, open, onOpenChange, returnFocus}: DangerousActionConfirmProps) {
    const focus = useReturnFocus(open, returnFocus);
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
            <AlertDialogContent {...(trigger ? {} : focus)}>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription asChild><div className="text-muted-foreground space-y-2 text-sm">{description}</div></AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onConfirm} className="bg-destructive hover:bg-destructive/90 text-white">{confirmLabel}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
