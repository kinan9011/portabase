"use client";

import * as React from "react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Switch} from "@/components/ui/switch";
import type {IntegrationsConnection} from "@/fork/arcane/integrations-view";
import {ARCANE_KEY_FIELD_COPY} from "@/fork/arcane/key-input-contract";
import {ReasonButton} from "@/fork/ui/disabled-reason";
import {type SecretKeyHandle, SecretKeyInput } from "@/fork/ui/integrations/secret-key-input";
import type {SaveVars} from "@/fork/ui/integrations/use-integrations-actions";
import {TONE_MAP} from "@/fork/ui/tone";
import {ToneIcon} from "@/fork/ui/tone-badge";

/** Same identity rule as the server (`endpointIdentity`): scheme + host + port, default ports filled, path ignored. */
export function clientEndpointIdentity(raw: string): string | null {
    try {
        const u = new URL(raw.trim());
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
    } catch {
        return null;
    }
}

export const PermissionList = () => (
    <div id="arcane-permission-help" className="bg-muted/40 rounded-lg border p-4 text-sm">
        <p className="font-medium">Before you connect</p>
        <p className="text-muted-foreground mt-1">{ARCANE_KEY_FIELD_COPY.help}</p>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            <div><dt className="text-muted-foreground text-xs">Global permissions</dt><dd className="font-mono text-xs">{ARCANE_KEY_FIELD_COPY.requiredPermissions.global.join(", ")}</dd></div>
            <div><dt className="text-muted-foreground text-xs">Per environment</dt><dd className="font-mono text-xs">{ARCANE_KEY_FIELD_COPY.requiredPermissions.perEnvironment.join(", ")}</dd></div>
        </dl>
    </div>
);

/**
 * Create / edit. One honest primary action: the server verifies (version, key permissions, every environment) BEFORE storing
 * anything, so the button says "Verify and save" — there is no separate "saved but untested" state to fake.
 */
export function ConnectionForm({connection, keyRef, pending, lockedReason, onSubmit, onCancel, endpointError}: {
    connection: IntegrationsConnection | null;
    keyRef: React.RefObject<SecretKeyHandle | null>;
    pending: boolean;
    lockedReason: string | null;
    onSubmit: (v: SaveVars) => void;
    onCancel?: () => void;
    endpointError?: string | null;
}) {
    const [name, setName] = React.useState(connection?.name ?? "Arcane");
    const [baseUrl, setBaseUrl] = React.useState(connection?.baseUrl ?? "");
    const [tlsInsecure, setTlsInsecure] = React.useState(connection?.tlsInsecure ?? false);
    const [tier2, setTier2] = React.useState(connection?.allowProjectsRead ?? false);
    const endpointChanged = !!connection && clientEndpointIdentity(baseUrl) !== clientEndpointIdentity(connection.baseUrl);
    const keyRequired = !connection || endpointChanged;
    const nameId = React.useId();
    const urlId = React.useId();
    const errId = React.useId();

    return (
        <form
            method="post" // never a GET: even before hydration the key can not end up in a URL
            onSubmit={(e) => {
                e.preventDefault();
                if (lockedReason || pending) return;
                if (keyRequired && !keyRef.current?.hasValue()) return; // the browser's `required` message already told the user
                onSubmit({connectionId: connection?.id, name: name.trim(), baseUrl: baseUrl.trim(), tlsInsecure, allowProjectsRead: tier2});
            }}
            className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
            aria-label={connection ? "Edit Arcane connection" : "Connect Arcane"}
        >
            <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={nameId}>Name</Label>
                    <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} maxLength={128} required autoComplete="off"/>
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={urlId}>Manager URL *</Label>
                    <Input id={urlId} type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://arcane.example.internal" required autoComplete="off" spellCheck={false} aria-describedby={endpointError ? errId : undefined} aria-invalid={endpointError ? true : undefined}/>
                    {endpointError && <p id={errId} role="alert" className="text-destructive text-sm">{endpointError}</p>}
                    <p className="text-muted-foreground text-xs">HTTPS. Private or loopback addresses work only when the server operator allow-listed them.</p>
                </div>
                {endpointChanged && (
                    <p role="note" className={`flex items-start gap-2 rounded-md border p-3 text-sm ${TONE_MAP.warning.panel} ${TONE_MAP.warning.body}`}>
                        <ToneIcon tone="warning" className="mt-0.5"/>{ARCANE_KEY_FIELD_COPY.endpointChange}
                    </p>
                )}
                <SecretKeyInput ref={keyRef} stored={!!connection} required={keyRequired} describedBy="arcane-permission-help"/>
                <p className="text-muted-foreground -mt-2 text-xs">Write-only. Sent once over this request, encrypted on the server, never shown again{connection ? "; leave empty to keep the stored key" : ""}.</p>

                <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                    <div><Label htmlFor="tls-insecure">Skip TLS certificate verification</Label><p className="text-muted-foreground text-xs">Off by default. Lab or private CA only.</p>
                        {tlsInsecure && <p role="note" className={`mt-1 flex items-start gap-1.5 text-xs ${TONE_MAP.warning.title}`}><ToneIcon tone="warning" className="mt-0.5"/>{ARCANE_KEY_FIELD_COPY.tlsWarning}</p>}</div>
                    <Switch id="tls-insecure" checked={tlsInsecure} onCheckedChange={setTlsInsecure}/>
                </div>
                <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                    <div><Label htmlFor="tier2">Allow reading Compose files ({ARCANE_KEY_FIELD_COPY.tier2.permission})</Label><p className="text-muted-foreground text-xs">Off by default.</p>
                        {tier2 && <p role="note" className={`mt-1 flex items-start gap-1.5 text-xs ${TONE_MAP.warning.title}`}><ToneIcon tone="warning" className="mt-0.5"/>{ARCANE_KEY_FIELD_COPY.tier2.warning}</p>}</div>
                    <Switch id="tier2" checked={tier2} onCheckedChange={setTier2}/>
                </div>

                <div className="flex flex-wrap items-start gap-2">
                    <ReasonButton type="submit" reason={lockedReason}>{pending ? "Verifying…" : "Verify and save"}</ReasonButton>
                    {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
                </div>
            </div>
            <PermissionList/>
        </form>
    );
}
