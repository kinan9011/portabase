"use client";

import * as React from "react";
import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {RadioGroup, RadioGroupItem} from "@/components/ui/radio-group";
import {rollbackMirrorAction} from "@/fork/actions/mirror.action";
import type {MirrorView} from "@/fork/mirror/view";
import {useReturnFocus} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {MIRRORS, retryText} from "@/fork/ui/mirrors/labels";
import type {Action} from "@/fork/ui/mirrors/model";
import {rollbackRows, rollbackTargets} from "@/fork/ui/mirrors/refresh/model";
import {DESTRUCTIVE_AA} from "@/fork/ui/recovery/style";
import {useAnnounce} from "@/fork/ui/status-announcer";

const B = MIRRORS.rollback;
const dataOf = (r: unknown): Record<string, unknown> | null => { const d = (r as {data?: unknown} | undefined)?.data; return d && typeof d === "object" ? (d as Record<string, unknown>) : null; };
const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : "unknown");

/**
 * Rollback dialog (plan-W25 A7): choose a kept earlier revision → what changes / what is lost (the CURRENT revision is deleted after the switch, no roll-forward) → typed mirror name → `rollbackMirror`.
 * Targets come from the polled view with the SAME predicate as the server (`rollbackTargets`). No server preview: everything needed is already in the view and the detail extras.
 */
export function RollbackMirrorButton({view, rpDates, memBytes, action, onDone}: {view: MirrorView; rpDates: Record<string, string>; memBytes: number; action: Action; onDone?: () => void}) {
    const announce = useAnnounce();
    const [open, setOpen] = React.useState(false);
    const focus = useReturnFocus(open);
    const [sel, setSel] = React.useState<string | null>(null);
    const [typed, setTyped] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [err, setErr] = React.useState<string | null>(null);
    const nameId = React.useId();
    const pickId = React.useId();
    if ("hidden" in action) return null;
    const blocked = "reason" in action ? action.reason : null;
    const name = view.mirror.name;
    const targets = rollbackTargets(view);
    const target = targets.find((t) => t.id === sel) ?? null;
    const cur = view.revisions.find((r) => r.id === view.mirror.activeRevisionId)?.seq ?? 0;
    const reason = busy ? B.working : !target ? (targets.length === 0 ? B.none : B.reasons.target) : typed.trim() !== name ? B.reasons.name : null;

    const close = (next: boolean) => {
        setOpen(next);
        setSel(next ? (targets[0]?.id ?? null) : null); // pre-select the newest target (OD-W25-3)
        if (!next) { setTyped(""); setErr(null); }
    };
    const submit = async () => {
        if (busy || reason || !target) return;
        setBusy(true); setErr(null);
        try {
            const d = dataOf(await rollbackMirrorAction({mirrorId: view.mirror.id, revisionId: target.id, confirmName: typed.trim()}));
            if (d?.ok === true) { announce(d.already === true ? B.already : B.started(target.seq, cur)); close(false); onDone?.(); }
            else { const t = d ? retryText(d.code, d.retryAfterSeconds) : MIRRORS.lifecycle.failed; setErr(t); announce(t); }
        } catch { setErr(MIRRORS.lifecycle.failed); announce(MIRRORS.lifecycle.failed); } finally { setBusy(false); }
    };

    return (
        <span className="inline-flex flex-col items-start gap-1">
            <ReasonButton type="button" variant="outline" size="sm" reason={blocked} onClick={() => close(true)} data-testid="mirror-rollback" aria-label={`${B.open} ${name}`}>{B.open}</ReasonButton>
            <Dialog open={open} onOpenChange={close}>
                <DialogContent data-testid="rollback-dialog" {...focus}>
                    <DialogHeader>
                        <DialogTitle>{B.title(name)}</DialogTitle>
                        <DialogDescription>{B.current(cur)}</DialogDescription>
                    </DialogHeader>
                    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                        <section aria-labelledby={pickId} className="space-y-2">
                            <h3 id={pickId} className="text-sm font-semibold">{B.pick}</h3>
                            {targets.length === 0 ? <p data-testid="rollback-none" className="text-sm">{B.none}</p> : (
                                <RadioGroup value={sel ?? ""} onValueChange={setSel} aria-labelledby={pickId} data-testid="rollback-rev">
                                    {targets.map((t) => (
                                        <div key={t.id} className="flex items-start gap-2">
                                            <RadioGroupItem id={`${pickId}-${t.id}`} value={t.id} className="mt-1"/>
                                            <Label htmlFor={`${pickId}-${t.id}`} className="font-normal">{B.rev(t.seq, t.rpSequence, day(rpDates[String(t.rpSequence)]), day(t.createdAt))}</Label>
                                        </div>
                                    ))}
                                </RadioGroup>
                            )}
                        </section>
                        {target && (
                            <section className="space-y-3" data-testid="rollback-changes">
                                <dl data-testid="rollback-rows" className="space-y-2 text-sm">
                                    {rollbackRows(view, target, rpDates, memBytes).map((r) => (
                                        <div key={r.key} data-row={r.key}><dt className="font-medium">{B.rows[r.key]}</dt><dd className="text-muted-foreground break-words">{r.text}</dd></div>
                                    ))}
                                </dl>
                                <p className="text-muted-foreground text-sm">{B.tunnel}</p>
                            </section>
                        )}
                        <div className="space-y-2">
                            <Label htmlFor={nameId} className="text-sm font-medium">{B.input}: <strong className="break-all">{name}</strong></Label>
                            <Input id={nameId} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" data-gramm="false" data-1p-ignore/>
                        </div>
                        {err && <div role="alert" data-testid="rollback-error" className="rounded-md border p-3 text-sm">{err}</div>}
                        <DialogFooter className="items-start">
                            <Button type="button" variant="outline" onClick={() => close(false)}>{B.cancel}</Button>
                            <ReasonButton type="submit" reason={reason} className={`${DESTRUCTIVE_AA} text-white`} data-testid="rollback-confirm">{busy ? B.working : target ? B.confirm(target.seq) : B.open}</ReasonButton>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </span>
    );
}
