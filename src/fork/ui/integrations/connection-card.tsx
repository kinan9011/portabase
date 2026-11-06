"use client";

import {Plug, RefreshCw, Unplug} from "lucide-react";
import * as React from "react";
import {Button} from "@/components/ui/button";
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from "@/components/ui/dialog";
import type {Verification} from "@/fork/arcane/connection-service";
import type {IntegrationsConnection} from "@/fork/arcane/integrations-view";
import {DangerousActionConfirm, useReturnFocus} from "@/fork/ui/dangerous-action-confirm";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {connectionAlert} from "@/fork/ui/integrations/connection-state";
import {SecretKeyInput, type SecretKeyHandle} from "@/fork/ui/integrations/secret-key-input";
import {PermissionList} from "@/fork/ui/integrations/connection-form";
import {CONNECTION_STATE_LABELS, SYNC_NOW, type ConnectionState} from "@/fork/ui/labels";
import {TONE_MAP} from "@/fork/ui/tone";
import {ToneBadge, ToneIcon} from "@/fork/ui/tone-badge";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"}) : "Never");

export function StateBadge({state}: {state: ConnectionState}) {
    const l = CONNECTION_STATE_LABELS[state];
    return <ToneBadge tone={l.tone} busy={l.busy}>{l.label}</ToneBadge>;
}

export function ProblemAlert({state, errorClass}: {state: ConnectionState; errorClass: string | null}) {
    const a = connectionAlert(state, errorClass);
    if (!a) return null;
    const t = TONE_MAP[a.tone];
    return (
        <div role="alert" data-testid="connection-alert" className={`mx-6 mt-5 flex gap-3 rounded-lg border p-4 ${t.panel}`}>
            <ToneIcon tone={a.tone} className="mt-0.5 size-4"/>
            <div className="text-sm"><p className={`font-semibold ${t.title}`}>{a.title}</p><p className={`mt-0.5 ${t.body}`}>{a.body}</p></div>
        </div>
    );
}

/** What the last real check found (from the action's `Verification`, never from a guess). */
export function VerificationPanel({v}: {v: Verification}) {
    const reachable = v.environments.filter((e) => e.reachable).length;
    return (
        <div data-testid="verification" className="mx-6 mt-5 rounded-lg border p-4 text-sm">
            <p className="font-medium">Last check: {v.ok ? `Arcane ${v.version ?? "?"}, ${reachable} of ${v.environments.length} environment${v.environments.length === 1 ? "" : "s"} reachable` : "failed"}</p>
            {v.extraPermissions.length > 0 && <p className="mt-1">Permissions the key must not hold: <span className="font-mono">{v.extraPermissions.join(", ")}</span></p>}
            {v.missingPermissions.length > 0 && <p className="mt-1">Missing: <span className="font-mono">{v.missingPermissions.join("; ")}</span></p>}
            {v.environments.some((e) => !e.reachable) && <p className="mt-1">Not reachable: {v.environments.filter((e) => !e.reachable).map((e) => `${e.name} (${e.errorClass ?? "unreachable"})`).join(", ")}</p>}
        </div>
    );
}

function RotateDialog({open, onOpenChange, keyRef, pending, onRotate, error}: {open: boolean; onOpenChange: (o: boolean) => void; keyRef: React.RefObject<SecretKeyHandle | null>; pending: boolean; onRotate: () => void; error: string | null}) {
    const focus = useReturnFocus(open);
    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) keyRef.current?.clear(); onOpenChange(o); }}>
            <DialogContent className="sm:max-w-xl" {...focus}>
                <form method="post" onSubmit={(e) => { e.preventDefault(); if (!pending) onRotate(); }} className="grid gap-4">
                    <DialogHeader>
                        <DialogTitle>Rotate the Arcane key</DialogTitle>
                        <DialogDescription>The new key is verified against Arcane first. If it is refused, the stored key stays in use and nothing changes. Backups and recovery points are not affected.</DialogDescription>
                    </DialogHeader>
                    <SecretKeyInput ref={keyRef} required describedBy="arcane-permission-help" label="New discovery key (list permissions only)"/>
                    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    <PermissionList/>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                        <Button type="submit" aria-disabled={pending || undefined}>{pending ? "Verifying…" : "Verify and rotate"}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ConnectionCard({connection, state, errorClass, lastVerification, lockedReason, pending, keyRef, onTest, onEdit, onRotate, onDisconnect, rotateError, rotateOpen, setRotateOpen, rotatePending}: {
    connection: IntegrationsConnection;
    state: ConnectionState;
    errorClass: string | null;
    lastVerification: Verification | null;
    lockedReason: string | null;
    pending: boolean;
    keyRef: React.RefObject<SecretKeyHandle | null>;
    onTest: () => void;
    onEdit: () => void;
    onRotate: () => void;
    onDisconnect: () => void;
    rotateError: string | null;
    rotateOpen: boolean;
    setRotateOpen: (o: boolean) => void;
    rotatePending: boolean;
}) {
    const label = CONNECTION_STATE_LABELS[state];
    const descId = React.useId();
    const [disconnectOpen, setDisconnectOpen] = React.useState(false);
    return (
        <section aria-labelledby="arcane-heading" aria-busy={label.busy || pending || undefined} className="rounded-xl border bg-card text-card-foreground shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b p-6">
                <div className="flex items-start gap-3">
                    <div className="flex size-12 items-center justify-center rounded-lg bg-primary/10 text-primary"><Plug className="size-6" aria-hidden="true"/></div>
                    <div>
                        <div className="flex flex-wrap items-center gap-2.5"><h2 id="arcane-heading" className="text-lg font-semibold">{connection.name}</h2><StateBadge state={state}/></div>
                        <p id={descId} className="mt-1 max-w-prose text-sm text-muted-foreground">{label.description}</p>
                    </div>
                </div>
                <div className="flex flex-wrap items-start gap-2">
                    <ReasonButton reason={SYNC_NOW.disabledReason} variant="outline"><RefreshCw aria-hidden="true"/>{SYNC_NOW.label}</ReasonButton>
                    <ReasonButton reason={lockedReason} variant="outline" onClick={onTest}>{pending ? "Testing…" : "Test connection"}</ReasonButton>
                    <ReasonButton reason={lockedReason} variant="outline" onClick={onEdit}>Edit</ReasonButton>
                    <ReasonButton reason={lockedReason} variant="outline" onClick={() => setRotateOpen(true)}>Rotate key</ReasonButton>
                    <ReasonButton reason={lockedReason} variant="outline" className="text-destructive" onClick={() => setDisconnectOpen(true)}><Unplug aria-hidden="true"/>Disconnect</ReasonButton>
                </div>
            </div>
            <ProblemAlert state={state} errorClass={errorClass}/>
            {lastVerification && <VerificationPanel v={lastVerification}/>}
            <dl className="grid gap-5 p-6 sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-xs text-muted-foreground">Manager URL</dt><dd className="mt-1 break-all font-mono text-sm">{connection.baseUrl}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Arcane version (tested)</dt><dd className="mt-1 text-sm">{connection.pinnedApiVersion ?? "Not verified yet"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">API key</dt><dd className="mt-1 text-sm">Stored, encrypted. Never shown again.</dd></div>
                <div><dt className="text-xs text-muted-foreground">Last checked</dt><dd className="mt-1 text-sm">{fmt(connection.lastCheckedAt)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">TLS verification</dt><dd className="mt-1 text-sm">{connection.tlsInsecure ? "OFF for this connection" : "On"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Compose file reading ({"projects:read"})</dt><dd className="mt-1 text-sm">{connection.allowProjectsRead ? "Allowed" : "Off"}</dd></div>
            </dl>
            <DangerousActionConfirm
                open={disconnectOpen}
                onOpenChange={setDisconnectOpen}
                title="Disconnect Arcane?"
                description={<><p>Portabase forgets the Arcane address and deletes the stored key. Discovery stops until you connect again.</p><p>Your backups, recovery points and stacks are <strong>not</strong> touched.</p></>}
                confirmLabel="Disconnect"
                onConfirm={onDisconnect}
            />
            <RotateDialog open={rotateOpen} onOpenChange={setRotateOpen} keyRef={keyRef} pending={rotatePending} onRotate={onRotate} error={rotateError}/>
        </section>
    );
}
