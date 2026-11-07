"use client";

import {useRouter} from "next/navigation";
import * as React from "react";
import {Alert, AlertDescription, AlertTitle} from "@/components/ui/alert";
import type {Outcome, Verification} from "@/fork/arcane/connection-service";
import type {EnvironmentOutcome} from "@/fork/arcane/environment-service";
import type {IntegrationsView} from "@/fork/arcane/integrations-view";
import type {SyncNowOutcome} from "@/fork/discovery/sync";
import {ConnectionCard} from "@/fork/ui/integrations/connection-card";
import {ConnectionForm} from "@/fork/ui/integrations/connection-form";
import {deriveConnectionState, type TransientState} from "@/fork/ui/integrations/connection-state";
import {SetupPath} from "@/fork/ui/integrations/empty-states";
import {EnvironmentTable} from "@/fork/ui/integrations/environment-table";
import type {SecretKeyHandle} from "@/fork/ui/integrations/secret-key-input";
import {type UiResult, useIntegrationsActions } from "@/fork/ui/integrations/use-integrations-actions";
import {CONNECTION_STATE_LABELS, REFUSAL_COPY, SYNC_COPY, SYNC_ERROR_LABELS} from "@/fork/ui/labels";
import {StatusAnnouncer, useAnnounce} from "@/fork/ui/status-announcer";
import {ToneIcon} from "@/fork/ui/tone-badge";

export type IntegrationsViewProps = {
    view: IntegrationsView;
    /** "Fork configuration locked: <failed check>" while the D21 self-check fails (§4.1), else null. */
    lockedReason: string | null;
    /** Fixture/test seam only: force a transient state. */
    forceTransient?: TransientState;
    /** Fixture/test seam only: pretend the last check produced this verification. */
    initialVerification?: Verification | null;
};

function Inner({view, lockedReason, forceTransient, initialVerification}: IntegrationsViewProps) {
    const announce = useAnnounce();
    const keyRef = React.useRef<SecretKeyHandle>(null);
    const [editing, setEditing] = React.useState(false);
    const [rotateOpen, setRotateOpen] = React.useState(false);
    const [rotateError, setRotateError] = React.useState<string | null>(null);
    const [formError, setFormError] = React.useState<string | null>(null);
    const [verification, setVerification] = React.useState<Verification | null>(initialVerification ?? null);
    const [warnings, setWarnings] = React.useState<string[]>([]);

    const router = useRouter();
    const actions = useIntegrationsActions(keyRef, (r: UiResult<Outcome | EnvironmentOutcome | SyncNowOutcome>, what) => {
        setRotateError(null); setFormError(null);
        if (r.kind === "ok" && what === "sync") {
            // the sync RAN: say what it found, from the returned run (code-only), never from a guess
            const run = (r.outcome as Extract<SyncNowOutcome, {ok: true}>).run;
            announce(run.status === "failed" ? SYNC_COPY.announce.failed(SYNC_ERROR_LABELS[run.connectionError ?? ""] ?? "see the environment table")
                : run.status === "partial" ? SYNC_COPY.announce.partial(run.totals.found) : SYNC_COPY.announce.ok(run.totals.found, run.totals.created + run.totals.changed));
            return;
        }
        if (r.kind === "ok") {
            const o = r.outcome as Outcome & {changed?: string[]};
            if ("verification" in o) { setVerification(o.verification); setWarnings(o.warnings); }
            if (what === "disconnect") { setVerification(null); announce("Disconnected. Backups and recovery points were kept."); return; }
            if (what === "environment") { announce(o.changed?.length ? "Environment settings saved." : "No change."); return; }
            if (what === "rotate") { setRotateOpen(false); announce("Key rotated. The new key was verified against Arcane."); return; }
            if (what === "save") setEditing(false);
            const v = (o as Outcome & {ok: true}).verification;
            const checkLabel = v && !v.ok ? CONNECTION_STATE_LABELS[deriveConnectionState({healthStatus: v.state, lastErrorClass: v.errorClass})].label : null;
            announce(checkLabel ? `${what === "save" ? "Saved, but the check reports" : "Check finished"}: ${checkLabel}.` : what === "save" ? "Saved. Arcane verified." : "Test finished. Arcane verified.");
            return;
        }
        // refused / failed: say exactly what the server said, change nothing on screen
        const msg = r.kind === "refused" ? (r.message || REFUSAL_COPY[r.code]) : r.message;
        if (what === "rotate") setRotateError(msg);
        if (what === "save") setFormError(msg);
        announce(`Not done: ${msg}`);
    });

    const c = view.connection;
    const syncing = actions.sync.isPending || !!c?.syncing;
    const transient: TransientState = forceTransient ?? (actions.save.isPending || actions.test.isPending || actions.rotate.isPending ? "testing" : syncing ? "syncing" : null);
    // a sync started elsewhere (cron / another tab / replica) holds the server lease: poll the server state until it ends
    const serverSyncing = !!c?.syncing && !actions.sync.isPending;
    React.useEffect(() => {
        if (!serverSyncing) return;
        const t = setInterval(() => router.refresh(), 3000);
        return () => clearInterval(t);
    }, [serverSyncing, router]);
    const state = deriveConnectionState(c, transient);
    const pending = actions.save.isPending || actions.test.isPending;
    const busyEnv = actions.environment.isPending ? (actions.environment.variables?.environmentId ?? null) : null;

    return (
        <div className="flex flex-col gap-6">
            {lockedReason && (
                <Alert data-testid="locked-banner"><ToneIcon tone="warning"/><AlertTitle>{lockedReason}</AlertTitle><AlertDescription>Existing schedules and notifications keep running. Fix the cause named in the title, then reload this page.</AlertDescription></Alert>
            )}
            {view.additionalConnections > 0 && <p role="note" className="text-muted-foreground text-sm">{view.additionalConnections} more Arcane connection{view.additionalConnections === 1 ? " exists" : "s exist"} in the database; only the first is shown.</p>}
            {warnings.map((w) => <Alert key={w} role="note"><ToneIcon tone="warning"/><AlertDescription>{w}</AlertDescription></Alert>)}
            {c && !editing ? (
                <ConnectionCard
                    connection={c} state={state} errorClass={c.lastErrorClass} lastVerification={verification} lockedReason={lockedReason} pending={pending} keyRef={keyRef}
                    onTest={() => { announce("Testing the connection…"); actions.test.mutate({connectionId: c.id}); }}
                    onEdit={() => setEditing(true)}
                    onRotate={() => { announce("Verifying the new key…"); actions.rotate.mutate({connectionId: c.id}); }}
                    onDisconnect={() => { announce("Disconnecting…"); actions.disconnect.mutate({connectionId: c.id}); }}
                    onSync={() => { announce(SYNC_COPY.announce.started); actions.sync.mutate({connectionId: c.id}); }}
                    syncing={syncing} hasEnabledEnvironment={view.environments.some((e) => e.enabled)}
                    rotateError={rotateError} rotateOpen={rotateOpen} setRotateOpen={setRotateOpen} rotatePending={actions.rotate.isPending}
                />
            ) : (
                <section aria-labelledby="arcane-heading" className="bg-card rounded-xl border shadow-sm">
                    {c ? <h2 id="arcane-heading" className="border-b p-6 text-lg font-semibold">Edit Arcane connection</h2> : <SetupPath/>}
                    <ConnectionForm
                        connection={c} keyRef={keyRef} pending={actions.save.isPending} lockedReason={lockedReason} endpointError={formError}
                        onSubmit={(v) => { announce("Verifying…"); actions.save.mutate(v); }} onCancel={c ? () => { keyRef.current?.clear(); setEditing(false); setFormError(null); } : undefined}
                    />
                </section>
            )}
            {c && <EnvironmentTable view={view} lockedReason={lockedReason} busyId={busyEnv} onChange={(v) => { announce("Saving environment settings…"); actions.environment.mutate(v); }}/>}
        </div>
    );
}

export function IntegrationsViewClient(props: IntegrationsViewProps) {
    return <StatusAnnouncer><Inner {...props}/></StatusAnnouncer>;
}
