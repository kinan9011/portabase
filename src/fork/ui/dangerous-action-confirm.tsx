"use client";

import * as React from "react";
import {AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger} from "@/components/ui/alert-dialog";

/**
 * Controlled copy-and-own confirm (D31, `DangerousActionConfirm` of the UI map) over Radix AlertDialog: focus trap, Escape
 * cancels, focus returns to the trigger, the safe action (Cancel) is focused first. The confirm button is the only way
 * through; `onConfirm` must call a real server action (no fake success). Either pass `trigger` or control `open` yourself.
 */
export type DangerousActionConfirmProps = {
    title: string;
    description: React.ReactNode;
    confirmLabel: string;
    onConfirm: () => void;
    trigger?: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
};

export function DangerousActionConfirm({title, description, confirmLabel, onConfirm, trigger, open, onOpenChange}: DangerousActionConfirmProps) {
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">{description}</div></AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={onConfirm} className="bg-destructive text-white hover:bg-destructive/90">{confirmLabel}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
