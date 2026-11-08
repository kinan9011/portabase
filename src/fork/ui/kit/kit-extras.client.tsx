"use client";

import * as React from "react";
import {Button} from "@/components/ui/button";
import {declareDashboardDbSourceAction} from "@/fork/actions/dashboard-db.action";
import {rotateKekAction} from "@/fork/actions/kit.action";
import type {Candidate, DashboardDbView} from "@/fork/dashboard-db/service";
import {DASHBOARD_DB, KEK_ROTATION} from "@/fork/ui/labels";
import {SecretInput, type SecretHandle} from "@/fork/ui/secret-input";
import {PRIMARY_AA} from "@/fork/ui/recovery/style";

/** D40 card: choose which existing source backs up the dashboard DB, and see the honest verdict. */
export function DashboardDbCard({view, candidates, disabled}: {view: DashboardDbView; candidates: Candidate[]; disabled: boolean}) {
    const [sel, setSel] = React.useState<string>("");
    const [verdict, setVerdict] = React.useState(view.verdict);
    const [msg, setMsg] = React.useState<string | null>(null);
    async function save(e: React.FormEvent) {
        e.preventDefault();
        const r = await declareDashboardDbSourceAction({databaseId: sel === "" ? null : sel});
        const d = r?.data;
        if (d && d.ok) { setVerdict(d.view.verdict); setMsg(DASHBOARD_DB.saved); } else setMsg(DASHBOARD_DB.errors[d && !d.ok ? d.code : "invalid_input"]);
    }
    return (
        <section aria-labelledby="dbsrc" className="flex flex-col gap-3 rounded-xl border p-4" data-testid="dashboard-db-card" data-verdict={verdict}>
            <h2 id="dbsrc" className="font-semibold">{DASHBOARD_DB.heading}</h2>
            <p className="text-sm text-muted-foreground">{DASHBOARD_DB.intro}</p>
            <p className="text-sm font-medium" data-testid="dashboard-db-verdict">{DASHBOARD_DB.verdicts[verdict]}</p>
            {view.channels.length > 0 && <ul className="text-sm text-muted-foreground">{view.channels.map((c) => <li key={c.name}>{c.name} ({c.provider}){c.local ? " · on the dashboard host" : ""}{c.sharedWithOtherHosts ? " · shared with another host" : ""}</li>)}</ul>}
            <form method="post" onSubmit={save} className="flex flex-col gap-2">
                <label htmlFor="dbsrc-select" className="text-sm">{DASHBOARD_DB.select}</label>
                <select id="dbsrc-select" value={sel} onChange={(e) => setSel(e.target.value)} disabled={disabled} className="max-w-sm rounded-md border bg-background p-2 text-sm">
                    <option value="">{DASHBOARD_DB.none}</option>
                    {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.agentName ? ` (${c.agentName})` : ""}</option>)}
                </select>
                <Button type="submit" disabled={disabled} className={`w-fit ${PRIMARY_AA}`}>{DASHBOARD_DB.save}</Button>
            </form>
            <p role="status" className="min-h-5 text-sm">{msg}</p>
            <p className="text-xs text-muted-foreground">{DASHBOARD_DB.restoreNote}</p>
        </section>
    );
}

/** KEK rotation + re-encrypt (ADR-013 §4): admin + step-up password. */
export function KekCard({disabled}: {disabled: boolean}) {
    const pw = React.useRef<SecretHandle>(null);
    const [msg, setMsg] = React.useState<string | null>(null);
    async function rotate(e: React.FormEvent) {
        e.preventDefault();
        const password = pw.current?.take();
        if (!password) return setMsg(KEK_ROTATION.errors.invalid_input);
        const r = await rotateKekAction({password});
        const d = r?.data;
        setMsg(d && d.ok ? KEK_ROTATION.done(d.moved) : KEK_ROTATION.errors[d && !d.ok ? d.code : "invalid_input"] ?? KEK_ROTATION.errors.invalid_input);
    }
    return (
        <section aria-labelledby="kek" className="flex flex-col gap-3 rounded-xl border p-4">
            <h2 id="kek" className="font-semibold">{KEK_ROTATION.heading}</h2>
            <p className="text-sm text-muted-foreground">{KEK_ROTATION.intro}</p>
            <form method="post" onSubmit={rotate} className="flex flex-col gap-3">
                <SecretInput ref={pw} label={KEK_ROTATION.password} name="kek-password" required purpose="current-password"/>
                <Button type="submit" disabled={disabled} variant="outline" className="w-fit">{KEK_ROTATION.button}</Button>
            </form>
            <p role="status" className="min-h-5 text-sm">{msg}</p>
        </section>
    );
}
