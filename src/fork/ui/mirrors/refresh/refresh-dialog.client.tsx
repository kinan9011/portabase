"use client";

import {TriangleAlert} from "lucide-react";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Checkbox} from "@/components/ui/checkbox";
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {RadioGroup, RadioGroupItem} from "@/components/ui/radio-group";
import {previewMirrorRefreshAction, refreshMirrorAction} from "@/fork/actions/mirror.action";
import type {RefreshPreview} from "@/fork/mirror/refresh-preview";
import type {MirrorView} from "@/fork/mirror/view";
import {useReturnFocus} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {MIRRORS, reasonText, retryText} from "@/fork/ui/mirrors/labels";
import type {Action} from "@/fork/ui/mirrors/model";
import {capacityWarning, refreshRows} from "@/fork/ui/mirrors/refresh/model";
import {DESTRUCTIVE_AA} from "@/fork/ui/recovery/style";
import {useAnnounce} from "@/fork/ui/status-announcer";
import {TONE_MAP} from "@/fork/ui/tone";

const R = MIRRORS.refresh;
const dataOf = (r: unknown): Record<string, unknown> | null => { const d = (r as {data?: unknown} | undefined)?.data; return d && typeof d === "object" ? (d as Record<string, unknown>) : null; };
const day = (iso: string) => iso.slice(0, 10);

/**
 * Refresh dialog (plan-W25 A6): pick a strictly newer verified backup → read-only preview (space, memory, app change, what is lost / deleted) → typed mirror name (+ privacy acknowledgement) → the SAME
 * `refreshMirror` service W24 tested. The dialog is a convenience: every rule is re-checked on the server. No fake success: the announcement says the refresh STARTED; the page says refreshed only when the polled view
 * shows the new active revision. Local state only (the typed name never leaves this component and is cleared on every close).
 */
export function RefreshMirrorButton({view, action, onDone}: {view: MirrorView; action: Action; onDone?: () => void}) {
    const announce = useAnnounce();
    const [open, setOpen] = React.useState(false);
    const focus = useReturnFocus(open); // focus returns to the opener (the Refresh button), not <body>
    const [sel, setSel] = React.useState<string | null>(null);
    const [preview, setPreview] = React.useState<RefreshPreview | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [previewErr, setPreviewErr] = React.useState<string | null>(null);
    const [ack, setAck] = React.useState(false);
    const [typed, setTyped] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [refusal, setRefusal] = React.useState<{text: string; blockers: string[]} | null>(null);
    const req = React.useRef(0);
    const nameId = React.useId();
    const pickId = React.useId();
    const mirrorId = view.mirror.id;
    const name = view.mirror.name;

    const close = (next: boolean) => {
        setOpen(next);
        if (!next) { setSel(null); setPreview(null); setPreviewErr(null); setLoading(false); setAck(false); setTyped(""); setRefusal(null); req.current++; }
    };

    // candidates first (rpId null), then the plan of the selection; a stale response (an older request than the latest) is ignored
    React.useEffect(() => {
        if (!open) return;
        const n = ++req.current;
        setLoading(true); setPreviewErr(null);
        void (async () => {
            try {
                const d = dataOf(await previewMirrorRefreshAction({mirrorId, rpId: sel}));
                if (n !== req.current) return;
                if (d?.ok === true && d.preview) {
                    const p = d.preview as RefreshPreview;
                    setPreview(p);
                    if (sel === null && p.candidates[0]) setSel(p.candidates[0].id);
                } else setPreviewErr(d ? retryText(d.code, d.retryAfterSeconds) : R.previewFailed);
            } catch { if (n === req.current) setPreviewErr(R.previewFailed); } finally { if (n === req.current) setLoading(false); }
        })();
    }, [open, sel, mirrorId]);

    if ("hidden" in action) return null;
    const blocked = "reason" in action ? action.reason : null;
    const active = view.revisions.find((r) => r.id === view.mirror.activeRevisionId);
    const cur = active?.seq ?? 0;
    const next = view.revisions.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
    const now = new Date();
    const needsAck = view.privacy.containsPersonalData !== false;
    const selected = preview?.selected && preview.selected.rpId === sel ? preview.selected : null;
    const warn = preview && selected ? capacityWarning(preview, now) : null;
    const reason = busy ? R.working
        : preview && preview.candidates.length === 0 ? R.reasons.pick
        : !sel ? R.reasons.pick
        : !selected ? R.reasons.plan
        : selected.outcome !== "ready" ? R.reasons.planBlocked
        : needsAck && !ack ? R.reasons.ack
        : typed.trim() !== name ? R.reasons.name : null;

    const submit = async () => {
        if (busy || reason || !sel) return;
        setBusy(true); setRefusal(null);
        try {
            const d = dataOf(await refreshMirrorAction({mirrorId, rpId: sel, confirmName: typed.trim(), acknowledgePrivacy: ack}));
            if (d?.ok === true) {
                announce(d.already === true ? R.already : R.started(next, cur));
                close(false); onDone?.();
            } else {
                const text = d ? retryText(d.code, d.retryAfterSeconds) : MIRRORS.lifecycle.failed;
                setRefusal({text, blockers: Array.isArray(d?.blockers) ? [...new Set((d.blockers as unknown[]).filter((b): b is string => typeof b === "string"))].slice(0, 20) : []});
                announce(text);
            }
        } catch { setRefusal({text: MIRRORS.lifecycle.failed, blockers: []}); announce(MIRRORS.lifecycle.failed); } finally { setBusy(false); }
    };

    return (
        <span className="inline-flex flex-col items-start gap-1">
            <ReasonButton type="button" variant="outline" size="sm" reason={blocked} onClick={() => close(true)} data-testid="mirror-refresh" aria-label={`${R.open} ${name}`}>{R.open}</ReasonButton>
            <Dialog open={open} onOpenChange={close}>
                <DialogContent data-testid="refresh-dialog" {...focus}>
                    <DialogHeader>
                        <DialogTitle>{R.title(name)}</DialogTitle>
                        <DialogDescription>{R.intro(next, cur)}</DialogDescription>
                    </DialogHeader>
                    <form method="post" className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                        <section aria-labelledby={pickId} className="space-y-2">
                            <h3 id={pickId} className="text-sm font-semibold">{R.pick}</h3>
                            {previewErr && <p role="alert" data-testid="refresh-preview-error" className="text-sm">{previewErr}</p>}
                            {preview && preview.candidates.length === 0 && !previewErr && <p data-testid="refresh-none" className="text-sm">{R.none}</p>}
                            {preview && preview.candidates.length > 0 && (
                                <RadioGroup value={sel ?? ""} onValueChange={setSel} aria-labelledby={pickId} data-testid="refresh-rp">
                                    {preview.candidates.map((c) => (
                                        <div key={c.id} className="flex items-start gap-2">
                                            <RadioGroupItem id={`${pickId}-${c.id}`} value={c.id} className="mt-1"/>
                                            <Label htmlFor={`${pickId}-${c.id}`} className="font-normal">{R.rp(c.sequence, day(c.createdAt))}</Label>
                                        </div>
                                    ))}
                                </RadioGroup>
                            )}
                        </section>
                        {sel && loading && !selected && <p data-testid="refresh-loading" className="text-muted-foreground text-sm">{R.loading}</p>}
                        {preview && selected && (
                            <section className="space-y-3" data-testid="refresh-changes">
                                <h3 className="text-sm font-semibold">{R.changes}</h3>
                                {selected.outcome !== "ready" && (
                                    <div role="alert" data-testid="refresh-blocked" className={`rounded-md border p-3 text-sm ${TONE_MAP.danger.panel}`}>
                                        <p className={TONE_MAP.danger.body}>{R.blocked}</p>
                                        {selected.blockers.length > 0 && <ul className={`list-disc pl-5 ${TONE_MAP.danger.body}`}>{[...new Set(selected.blockers)].map((b) => <li key={b}>{reasonText(b)}</li>)}</ul>}
                                    </div>
                                )}
                                <dl data-testid="refresh-rows" className="space-y-2 text-sm">
                                    {refreshRows(preview, view, now).map((r) => (
                                        <div key={r.key} data-row={r.key}><dt className="font-medium">{R.rows[r.key]}</dt><dd className="text-muted-foreground break-words">{r.text}</dd></div>
                                    ))}
                                </dl>
                                {warn && (
                                    <p role="note" data-testid="refresh-capacity-warning" className={`flex items-start gap-2 rounded-md border p-3 text-sm ${TONE_MAP.warning.panel}`}>
                                        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0"/><span className={TONE_MAP.warning.body}>{warn}</span>
                                    </p>
                                )}
                                <p className="text-sm">{R.preserved}</p>
                                <p className="text-muted-foreground text-sm">{R.tunnel}</p>
                            </section>
                        )}
                        {needsAck && (
                            <div className="flex items-start gap-2">
                                <Checkbox id={`${nameId}-ack`} checked={ack} onCheckedChange={(c) => setAck(c === true)} className="mt-0.5"/>
                                <Label htmlFor={`${nameId}-ack`} className="font-normal">{R.ackLabel}</Label>
                            </div>
                        )}
                        <div className="space-y-2">
                            <Label htmlFor={nameId} className="text-sm font-medium">{R.input}: <strong className="break-all">{name}</strong></Label>
                            <Input id={nameId} value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoComplete="off" data-gramm="false" data-1p-ignore/>
                        </div>
                        {refusal && (
                            <div role="alert" data-testid="refresh-error" className="rounded-md border p-3 text-sm">
                                <p>{refusal.text}</p>
                                {refusal.blockers.length > 0 && <ul className="list-disc pl-5">{refusal.blockers.map((b) => <li key={b}>{reasonText(b)}</li>)}</ul>}
                            </div>
                        )}
                        <DialogFooter className="items-start">
                            <Button type="button" variant="outline" onClick={() => close(false)}>{R.dismiss}</Button>
                            <ReasonButton type="submit" reason={reason} className={`${DESTRUCTIVE_AA} text-white`} data-testid="refresh-confirm">{busy ? R.working : R.confirm(next)}</ReasonButton>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </span>
    );
}
