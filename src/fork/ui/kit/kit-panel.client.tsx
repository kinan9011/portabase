"use client";

import * as React from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {beginKitGenerationAction, confirmKitFingerprintAction} from "@/fork/actions/kit.action";
import type {KitView} from "@/fork/kit/service";
import {KIT} from "@/fork/ui/labels";
import {SecretInput, type SecretHandle} from "@/fork/ui/secret-input";

/**
 * Kit page body (W14, controlled copy). Secrets handling:
 *  - the account password and the passphrases live ONLY in uncontrolled DOM inputs (`SecretInput`), are read once at submit and cleared;
 *  - the paper kit exists only as a string in a ref while the print view is open (an iframe `srcDoc` with scripts disabled), then it is dropped: it never enters
 *    React state shown elsewhere, a query cache, a URL or browser storage; the digital kit is saved through one object URL that is revoked at once;
 *  - requests go to the no-store route handler; nothing is persisted.
 */
type Grant = {paper?: string; digital?: string};
const fmt = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

export function KitPanel({view, canManage, lockedReason}: {view: KitView; canManage: boolean; lockedReason: string | null}) {
    const pw = React.useRef<SecretHandle>(null);
    const pass = React.useRef<SecretHandle>(null);
    const pass2 = React.useRef<SecretHandle>(null);
    const [want, setWant] = React.useState<{paper: boolean; digital: boolean}>({paper: true, digital: false});
    const [grant, setGrant] = React.useState<Grant | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [msg, setMsg] = React.useState<{kind: "ok" | "error"; text: string} | null>(null);
    const [printOpen, setPrintOpen] = React.useState(false);
    const paperHtml = React.useRef<string | null>(null);
    const frame = React.useRef<HTMLIFrameElement>(null);
    const [code, setCode] = React.useState("");
    const [type, setType] = React.useState<"paper" | "digital">("paper");
    const disabled = !canManage || lockedReason !== null;
    const err = (c: string) => setMsg({kind: "error", text: KIT.errors[c] ?? KIT.errors.invalid_input});
    const dropPaper = () => { paperHtml.current = null; setPrintOpen(false); };
    React.useEffect(() => dropPaper, []);

    async function begin(e: React.FormEvent) {
        e.preventDefault();
        const types = (["paper", "digital"] as const).filter((t) => want[t]);
        const password = pw.current?.take();
        if (types.length === 0 || !password) return err("invalid_input");
        setBusy(true); setMsg(null);
        const r = await beginKitGenerationAction({types, password});
        setBusy(false);
        const d = r?.data;
        if (d && d.ok) { setGrant(d.tokens); setMsg({kind: "ok", text: KIT.create.ready}); } else err(d && !d.ok ? d.code : "invalid_input");
    }
    async function post(kind: "paper" | "digital", token: string, extra: Record<string, string> = {}) {
        const res = await fetch(`/api/fork/kit/${kind}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({token, ...extra}), cache: "no-store", credentials: "same-origin"});
        const body = await res.json().catch(() => ({}));
        return {ok: res.ok, body: body as {code?: string; html?: string; file?: string; filename?: string}};
    }
    async function showPaper() {
        if (!grant?.paper) return;
        setBusy(true); setMsg(null);
        const r = await post("paper", grant.paper);
        setBusy(false);
        setGrant((g) => ({...g, paper: undefined}));
        if (r.ok && r.body.html) { paperHtml.current = r.body.html; setPrintOpen(true); } else err(r.body.code ?? "invalid_input");
    }
    async function saveDigital(e: React.FormEvent) {
        e.preventDefault();
        if (!grant?.digital) return;
        const p = pass.current?.take(); const p2 = pass2.current?.take();
        if (!p || !p2) return err("weak_passphrase");
        setBusy(true); setMsg(null);
        const r = await post("digital", grant.digital, {passphrase: p, passphraseConfirm: p2});
        setBusy(false);
        if (!r.ok || !r.body.file) return err(r.body.code ?? "invalid_input");
        setGrant((g) => ({...g, digital: undefined}));
        const url = URL.createObjectURL(new Blob([r.body.file], {type: "text/plain"}));
        const a = document.createElement("a");
        a.href = url; a.download = r.body.filename ?? "portabase-recovery-kit.pbkit"; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setMsg({kind: "ok", text: KIT.create.saved});
    }
    async function confirm(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true); setMsg(null);
        const r = await confirmKitFingerprintAction({fingerprint: code, type});
        setBusy(false); setCode("");
        const d = r?.data;
        if (d && d.ok) setMsg({kind: "ok", text: KIT.confirm.ok}); else err(d && !d.ok ? d.code : "invalid_input");
    }

    const stateText = view.state === "none" ? KIT.states.none : view.state === "issued" ? KIT.states.issued : view.state === "stale" ? KIT.states.stale : KIT.states.verified(fmt(view.verifiedAt), KIT.types[view.verifiedType ?? "paper"]);
    return (
        <div className="flex flex-col gap-6">
            <section aria-labelledby="kit-state" className="flex flex-col gap-1 rounded-xl border p-4" data-testid="kit-state" data-kit-state={view.state}>
                <h2 id="kit-state" className="font-semibold">{KIT.page.title}</h2>
                <p className="text-sm text-muted-foreground">{KIT.page.intro}</p>
                <p className="text-sm font-medium">{stateText}</p>
                {view.state === "verified" && view.reverifyDueAt && <p className="text-xs text-muted-foreground">Verify again before {fmt(view.reverifyDueAt)}.</p>}
                {!canManage && <p className="text-sm">{KIT.page.notAdmin}</p>}
                {lockedReason && <p role="status" className="text-sm">{lockedReason}</p>}
            </section>

            <div role="status" aria-live="polite" data-testid="kit-status" className="min-h-5 text-sm">{msg && <span className={msg.kind === "error" ? "text-destructive" : ""}>{msg.text}</span>}</div>

            <section aria-labelledby="kit-create" className="flex flex-col gap-3 rounded-xl border p-4">
                <h2 id="kit-create" className="font-semibold">{KIT.create.heading}</h2>
                <p className="text-sm text-muted-foreground">{KIT.create.help}</p>
                <form method="post" onSubmit={begin} className="flex flex-col gap-3" aria-disabled={disabled}>
                    <SecretInput ref={pw} label={KIT.create.password} name="kit-password" required/>
                    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={want.paper} onChange={(e) => setWant((w) => ({...w, paper: e.target.checked}))}/>{KIT.create.paper}</label>
                        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={want.digital} onChange={(e) => setWant((w) => ({...w, digital: e.target.checked}))}/>{KIT.create.digital}</label>
                    </fieldset>
                    <Button type="submit" disabled={disabled || busy} className="w-fit">{busy ? KIT.create.working : KIT.create.start}</Button>
                </form>

                {grant?.paper && (
                    <div className="flex flex-col gap-2" data-testid="kit-paper-step">
                        <h3 className="font-medium">{KIT.create.paperHeading}</h3>
                        <p className="text-sm text-muted-foreground">{KIT.create.paperNote}</p>
                        <Button type="button" onClick={showPaper} disabled={busy} className="w-fit">{KIT.create.paperButton}</Button>
                    </div>
                )}
                {printOpen && paperHtml.current && (
                    <div className="flex flex-col gap-2" data-testid="kit-print-view">
                        <iframe ref={frame} title={KIT.create.paperHeading} sandbox="allow-same-origin allow-modals" srcDoc={paperHtml.current} className="h-[28rem] w-full rounded border bg-white"/>
                        <div className="flex gap-2">
                            <Button type="button" onClick={() => frame.current?.contentWindow?.print()}>{KIT.create.printButton}</Button>
                            <Button type="button" variant="outline" onClick={dropPaper}>{KIT.create.closeButton}</Button>
                        </div>
                    </div>
                )}
                {grant?.digital && (
                    <form method="post" onSubmit={saveDigital} className="flex flex-col gap-3" data-testid="kit-digital-step">
                        <h3 className="font-medium">{KIT.create.digitalHeading}</h3>
                        <SecretInput ref={pass} label={KIT.create.passphrase} name="kit-passphrase" required/>
                        <SecretInput ref={pass2} label={KIT.create.passphraseConfirm} name="kit-passphrase-confirm" required/>
                        <p className="text-sm text-muted-foreground">{KIT.create.digitalNote}</p>
                        <Button type="submit" disabled={busy} className="w-fit">{KIT.create.digitalButton}</Button>
                    </form>
                )}
            </section>

            <section aria-labelledby="kit-confirm" className="flex flex-col gap-3 rounded-xl border p-4">
                <h2 id="kit-confirm" className="font-semibold">{KIT.confirm.heading}</h2>
                <p className="text-sm text-muted-foreground">{KIT.confirm.help}</p>
                <form method="post" onSubmit={confirm} className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="kit-code">{KIT.confirm.code}</Label>
                        <Input id="kit-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} autoComplete="off" spellCheck={false} inputMode="text" disabled={disabled} className="max-w-sm font-mono"/>
                    </div>
                    <fieldset className="flex gap-4" disabled={disabled}>
                        <legend className="text-sm">{KIT.confirm.type}</legend>
                        {(["paper", "digital"] as const).map((t) => <label key={t} className="flex items-center gap-1 text-sm"><input type="radio" name="kit-type" checked={type === t} onChange={() => setType(t)}/>{KIT.types[t]}</label>)}
                    </fieldset>
                    <Button type="submit" disabled={disabled || busy || code.trim().length === 0} className="w-fit">{KIT.confirm.button}</Button>
                </form>
            </section>
        </div>
    );
}
